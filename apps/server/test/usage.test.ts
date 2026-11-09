import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import type { Api, AssistantMessageEvent, Model, Usage, ToolChoice } from '@earendil-works/pi-ai';
import type { CredentialStore } from '../src/infrastructure/credentials/store.js';
import type { ModelGateway } from '../src/agent/model/pi-gateway.js';
import { UsageStore, RunContext } from '../src/agent/persistence/usage-store.js';
import { openDatabase, recoverInterrupted } from '../src/infrastructure/database/database.js';
import { seedWorld, seedSession } from './fixtures/db-seed.js';
import { createApp } from '../src/app.js';

const model: Model<Api> = {
  id: 'fake', name: 'fake', provider: 'fake', api: 'openai-completions',
  baseUrl: 'http://localhost', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768, maxTokens: 4096,
};
const tokenUsage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage => ({
  input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
function seed() {
  const db = openDatabase(':memory:'), now = Date.now();
  seedWorld(db, 'world', {
    spec: 'world_card', spec_version: '0.1',
    data: { name: 'test', characters: [{ id: 'player', name: 'player', player_selectable: true }],
      openings: [{ id: 'opening', name: 'start', content: 'start' }] },
  });
  db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('config', 'test', 'fake', 'fake', 'ref', now, now);
  db.prepare('INSERT INTO presets(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('preset', 'test', JSON.stringify({
      name: 'test', budget: { max_output_tokens: 64 }, summary_prompt: 'summary',
      nodes: ['main', 'personaInfo', 'characterInfo', 'worldState', 'chatHistory', 'userInput', 'postHistory']
        .map(id => ({ id, kind: 'system', role: id === 'chatHistory' ? 'auto' : id === 'userInput' ? 'user' : 'system',
          enabled: true, content: id === 'main' ? 'hello' : '' })),
    }), now, now);
  seedSession(db, 'session', 'world', 'preset', 'player', 'opening-entry', null, '{}', now, now, 'config');
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('opening-entry', 'session', null, 'opening-run', 1, 'message', 'assistant', 0, now,
      JSON.stringify({ message: { role: 'assistant', content: 'opening' } }), '[]', '{}');
  return db;
}
function append(db: DatabaseSync, id: string, runId: string, seq: number, role: string | null, type: string, parentId: string) {
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'session', parentId, runId, seq, type, role, 0, Date.now(),
      JSON.stringify(role === 'user' ? { message: { role, content: 'continue' } } : { message: { role, content: 'story' } }),
      role === 'user' ? JSON.stringify({ run: { runId, status: 'running' } }) : '{}');
  db.prepare('UPDATE sessions SET tip_entry_id=? WHERE id=?').run(id, 'session');
}

it('aggregates assistant + compaction requests into one Run, with cache read/write included in input only once', () => {
  const db = seed(), store = new UsageStore(db), run = new RunContext('session', 'run-1', 'config');
  store.beginRun('session', 'run-1', 'request-1');
  const summary = run.request('summary');
  store.beginRequest(summary, 'fake', 32768);
  store.finishRequest(summary, 'completed', tokenUsage(100, 20, 30, 10), 20, 100);
  append(db, 'compaction', 'run-1', 2, null, 'compaction', 'opening-entry');
  append(db, 'user', 'run-1', 3, 'user', 'message', 'compaction');
  store.attachCompaction('session', 'run-1');

  const primary = run.request('generation');
  store.beginRequest(primary, 'fake', 32768);
  store.finishRequest(primary, 'completed', tokenUsage(300, 50, 150, 50), 40, 150);
  append(db, 'assistant', 'run-1', 4, 'assistant', 'message', 'user');
  store.attachEntry('session', 'run-1', primary.requestId, 'assistant');

  expect(store.settleRun('session', 'run-1', 'completed', 310)).toBe(true);
  expect(store.settleRun('session', 'run-1', 'completed', 310)).toBe(false);
  expect(store.view('session')).toMatchObject({
    cumulative: {
      inputTokens: 640, outputTokens: 70, totalTokens: 710,
      cacheReadTokens: 180, cacheWriteTokens: 60, reportedCount: 2, unknownCount: 0,
      cacheHitRate: 180 / 640, complete: true,
    },
    latestContext: { inputTokens: 500, contextWindowTokens: 32768, modelId: 'fake', stale: false },
  });
  const assistantMetrics = JSON.parse(String(db.prepare("SELECT metrics_json FROM entries WHERE id='assistant'").get()?.metrics_json));
  expect(assistantMetrics.requestId).toBe(primary.requestId);
  expect(Array.isArray(assistantMetrics)).toBe(false);
  expect(assistantMetrics).not.toHaveProperty('version');
  const summaryMetrics = JSON.parse(String(db.prepare("SELECT metrics_json FROM entries WHERE id='compaction'").get()?.metrics_json));
  expect(summaryMetrics.requests).toHaveLength(1);
  const userMetrics = JSON.parse(String(db.prepare("SELECT metrics_json FROM entries WHERE id='user'").get()?.metrics_json));
  expect(userMetrics.run).toMatchObject({ accounted: true, totalTokens: 710, inputTokens: 640 });
  db.close();
});

it('accounts for a failed preparation with no User Entry, then recovers persisted but interrupted requests once', () => {
  const db = seed(), store = new UsageStore(db);
  store.beginRun('session', 'failure', 'user-request');
  const summary = new RunContext('session', 'failure').request('summary');
  store.beginRequest(summary, 'fake', 32768);
  store.finishRequest(summary, 'completed', tokenUsage(100, 50, 40), undefined, 30);
  expect(store.settleRun('session', 'failure', 'failed')).toBe(true);
  expect(store.view('session').cumulative).toMatchObject({ inputTokens: 140, outputTokens: 50, totalTokens: 190 });
  expect(store.settleRun('session', 'failure', 'failed')).toBe(false);

  store.beginRun('session', 'interrupted', 'other-user-request');
  const request = new RunContext('session', 'interrupted').request('generation');
  store.beginRequest(request, 'fake', 32768);
  recoverInterrupted(db);
  recoverInterrupted(db);
  expect(store.view('session').cumulative).toMatchObject({
    totalTokens: 190, unknownCount: 1, reportedCount: 1, complete: false,
  });
  expect(JSON.parse(String(db.prepare("SELECT usage_json FROM sessions WHERE id='session'").get()?.usage_json)).pendingRun).toBe(null);
  db.close();
});

it('serves two Session dimensions through the server route and records real model usage for a Run', async () => {
  const db = seed();
  const gateway: ModelGateway = {
    resolve: () => model,
    toolVerified: () => true,
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', delta: 'response', contentIndex: 0, partial: {} as never } as AssistantMessageEvent;
        yield { type: 'done', reason: 'stop', message: {
          role: 'assistant', content: [{ type: 'text', text: 'response' }],
          api: 'openai-completions', provider: 'fake', model: 'fake',
          usage: tokenUsage(1000, 80, 500, 100), stopReason: 'stop', timestamp: Date.now(),
        } } as AssistantMessageEvent;
      },
    }),
  };
  const credentials: CredentialStore = { async get() { return 'test'; }, async set() {}, async delete() {} };
  const app = createApp(db, credentials, gateway);
  expect((await app.request('/api/v1/sessions/unknown/usage')).status).toBe(404);
  const start = await app.request('/api/v1/sessions/session/runs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'continue', expectedTipEntryId: 'opening-entry', requestId: randomUUID() }),
  });
  expect(start.status).toBe(202);
  const id = (await start.json() as {data:{runId:string}}).data.runId;
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = (await (await app.request(`/api/v1/sessions/session/runs/${id}`)).json() as { data:{status:string} }).data.status;
    if (status === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const response = await app.request('/api/v1/sessions/session/usage');
  expect(response.status).toBe(200);
  expect((await response.json() as {data:unknown}).data).toMatchObject({
    cumulative: {
      inputTokens: 1600, outputTokens: 80, totalTokens: 1680,
      cacheReadTokens: 500, cacheWriteTokens: 100, cacheHitRate: 500 / 1600,
    },
    latestContext: { inputTokens: 1600, contextWindowTokens: 32768, stale: false },
  });
  const user = db.prepare('SELECT metrics_json FROM entries WHERE run_id=? AND role=?').get(id, 'user');
  expect(JSON.parse(String(user?.metrics_json)).run).toMatchObject({ accounted: true, totalTokens: 1680 });
  db.close();
});

it('migrates an existing database in place without resetting previously stored rows', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const folder = mkdtempSync(join(tmpdir(), 'sr-usage-migrate-')), file = join(folder, 'legacy.sqlite');
  try {
    // Recreate the pre-feature schema by dropping only the two new columns,
    // preserving every other real table, index and trigger.
    const legacy = openDatabase(file);
    legacy.prepare('INSERT INTO presets(id,name,config_json,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run('legacy-preset', 'legacy', '{}', 1, 1);
    seedWorld(legacy, 'legacy-world', {
      spec: 'world_card', spec_version: '0.1',
      data: { name: 'legacy', characters: [{ id: 'player', name: 'player', player_selectable: true }],
        openings: [{ id: 'start', name: 'start', content: 'old text' }] },
    });
    legacy.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('legacy-config', 'old', 'fake', 'fake', 'ref', 1, 1);
    seedSession(legacy, 'old-session', 'legacy-world', 'legacy-preset', 'player', 'old-entry',
      'retained', '{}', 1, 1, 'legacy-config');
    legacy.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('old-entry', 'old-session', null, 'old-run', 1, 'message', 'assistant', 0, 1,
        '{"message":{"role":"assistant","content":"old text"}}', '{}');
    legacy.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('old-user', 'old-session', 'old-entry', 'old-run', 2, 'message', 'user', 0, 2,
        '{"message":{"role":"user","content":"continue"}}', '{"run":{"status":"completed"}}');
    legacy.exec('ALTER TABLE entries DROP COLUMN metrics_json; ALTER TABLE sessions DROP COLUMN usage_json;');
    legacy.close();
    const migrated = openDatabase(file);
    expect(migrated.prepare("SELECT title,usage_json FROM sessions WHERE id='old-session'").get()?.title).toBe('retained');
    expect(JSON.parse(String(migrated.prepare("SELECT usage_json FROM sessions WHERE id='old-session'").get()?.usage_json))
      .historicalUsageUnknown).toBe(true);
    expect(new UsageStore(migrated).view('old-session').cumulative.complete).toBe(false);
    expect(migrated.prepare("SELECT metrics_json FROM entries WHERE id='old-entry'").get()?.metrics_json).toBe(null);
    migrated.close();
    const again = openDatabase(file);
    expect(again.prepare("SELECT title FROM sessions WHERE id='old-session'").get()?.title).toBe('retained');
    again.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

it('counts only the narrative request for mandatory state-tool submissions', async () => {
  const db = openDatabase(':memory:');
  seedWorld(db, 'state-world', {
    spec: 'world_card', spec_version: '0.1', data: {
      name: 'state-world',
      characters: [{ id: 'player', name: 'player', player_selectable: true }],
      openings: [{ id: 'opening', name: 'opening', content: 'hello' }],
      state: { schema_version: 1, scopes: { message: {
        mood: { type: 'string', initial: 'normal', description: 'Update when changed' },
      } } },
    },
  });
  const credentials: CredentialStore = { async get() { return 'test'; }, async set() {}, async delete() {} };
  const gateway: ModelGateway = {
    resolve: () => model,
    toolVerified: () => true,
    stream: (_model, _context, opts) => ({
      async *[Symbol.asyncIterator]() {
        const required = opts.toolChoice === ('required' as ToolChoice);
        const message = {
          role: 'assistant', api: 'openai-completions', provider: 'fake', model: 'fake',
          content: required ? [{ type: 'text', text: 'story' },{ type: 'toolCall', id: 'state', name: 'update_state', arguments: { updates: [] } }]
            : [{ type: 'text', text: 'story' }],
          usage: tokenUsage(600, 50, 400, 100),
          stopReason: required ? 'toolUse' : 'stop', timestamp: Date.now(),
        };
        yield { type: 'done', reason: required ? 'toolUse' : 'stop', message } as AssistantMessageEvent;
      },
    }),
  };
  const app = createApp(db, credentials, gateway);
  const create = await app.request('/api/v1/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worldId: 'state-world', openingId: 'opening', userCharacterId: 'player' }),
  });
  expect(create.status).toBe(201);
  const session = (await create.json() as { data: { item: { id: string; tipEntryId: string } } }).data.item;
  const { AgentRuntime } = await import('../src/agent/runtime/agent-runtime.js');
  const runtime = new AgentRuntime(db, credentials, gateway);
  const { runId, stream } = await runtime.prepare(session.id, 'continue', randomUUID(), session.tipEntryId);
  const reader = stream.getReader();
  while (!(await reader.read()).done) { /* drain */ }
  expect(runtime.status(session.id, runId)?.status).toBe('completed');
  expect(new UsageStore(db).view(session.id)).toMatchObject({
    cumulative: {
      inputTokens: 1100, outputTokens: 50, totalTokens: 1150,
      cacheReadTokens: 400, cacheWriteTokens: 100, reportedCount: 1,
    },
    latestContext: { inputTokens: 1100, contextWindowTokens: 32768, stale: false },
  });
  const entries = db.prepare("SELECT metrics_json FROM entries WHERE session_id=? AND role='assistant' AND run_id=?")
    .all(session.id, runId);
  const phases = entries.map(row => JSON.parse(String(row.metrics_json)).phase);
  expect(phases).toEqual(['generation']);
  db.close();
});
