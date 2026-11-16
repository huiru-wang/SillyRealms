import {defaultPreset} from '../src/domain/preset/schema.js';
import {insertPreset} from '../src/repositories/preset-repository.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import type { Api, AssistantMessageEvent, Model, Usage } from '@earendil-works/pi-ai';
import type { CredentialStore } from '../src/infrastructure/credentials/store.js';
import type { ModelGateway } from '../src/runtime/model/pi-gateway.js';
import { UsageStore, RunAccounting } from '../src/runtime/persistence/usage-store.js';
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
  const preset=defaultPreset();preset.name='test';preset.context_strategy={...preset.context_strategy,max_context_tokens:12000,max_output_tokens:64};insertPreset(db,preset,'preset');
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
  const db = seed(), store = new UsageStore(db), run = new RunAccounting('session', 'run-1', 'config');
  store.beginRun('session', 'run-1', 'request-1');
  const summary = run.request('summary');
  store.beginRequest(summary, 'fake', 32768);
  store.finishRequest(summary, 'completed', tokenUsage(100, 20, 30, 10), 20, 100);
  append(db, 'compaction', 'run-1', 2, null, 'compaction', 'opening-entry');
  append(db, 'user', 'run-1', 3, 'user', 'message', 'compaction');
  store.attachCompaction('session', 'run-1');

  const primary = run.request('generation', { systemBytes:1200, summaryBytes:500, historyBytes:2300 });
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
    latestContext: { inputTokens: 500, contextWindowTokens: 32768, modelId: 'fake', stale: false, contextComposition:{systemBytes:1200,summaryBytes:500,historyBytes:2300} },
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
  const summary = new RunAccounting('session', 'failure').request('summary');
  store.beginRequest(summary, 'fake', 32768);
  store.finishRequest(summary, 'completed', tokenUsage(100, 50, 40), undefined, 30);
  expect(store.settleRun('session', 'failure', 'failed')).toBe(true);
  expect(store.view('session').cumulative).toMatchObject({ inputTokens: 140, outputTokens: 50, totalTokens: 190 });
  expect(store.settleRun('session', 'failure', 'failed')).toBe(false);

  store.beginRun('session', 'interrupted', 'other-user-request');
  const request = new RunAccounting('session', 'interrupted').request('generation');
  store.beginRequest(request, 'fake', 32768);
  recoverInterrupted(db);
  recoverInterrupted(db);
  expect(store.view('session').cumulative).toMatchObject({
    totalTokens: 190, unknownCount: 1, reportedCount: 1, complete: false,
  });
  expect(JSON.parse(String(db.prepare("SELECT usage_json FROM sessions WHERE id='session'").get()?.usage_json)).pendingRun).toBe(null);
  db.close();
});

it('clears an old context snapshot when the latest narrative request has no usage', () => {
  const db = seed(), store = new UsageStore(db);
  store.beginRun('session', 'first', 'first-request');
  const first = new RunAccounting('session', 'first', 'config').request('generation');
  store.beginRequest(first, 'fake', 32768);
  store.finishRequest(first, 'completed', tokenUsage(200, 30), undefined, 1);
  store.settleRun('session', 'first', 'completed');
  expect(store.view('session').latestContext).toMatchObject({inputTokens:200, outputTokens:30});
  store.beginRun('session', 'second', 'second-request');
  const second = new RunAccounting('session', 'second', 'config').request('generation');
  store.beginRequest(second, 'fake', 32768);
  store.finishRequest(second, 'error', undefined, undefined, 1);
  store.settleRun('session', 'second', 'failed');
  expect(store.view('session').latestContext).toBeNull();
  db.close();
});

it.each([
  {input:100, output:20, compress:true},
  {input:31_600, output:80, compress:false},
  {input:null, output:null, compress:true},
])('measures the current request independently of previous reported usage: $input / $output', async ({input,output,compress}) => {
  const db = seed();
  let parent = 'opening-entry';
  for (let i = 0; i < 6; i++) {
    const user = `user-${i}`, assistant = `assistant-${i}`;
    append(db, user, `run-${i}`, 2 + i * 2, 'user', 'message', parent);
    append(db, assistant, `run-${i}`, 3 + i * 2, 'assistant', 'message', user);
    parent = assistant;
  }
  db.prepare("UPDATE presets SET context_strategy=json_patch(context_strategy,json(?))").run(JSON.stringify({strategy:'rolling_summary',max_context_tokens:12000,max_output_tokens:64}));
  // Current input measurement controls compaction, independent of the preceding request's usage.
  db.prepare('UPDATE entries SET payload=? WHERE id=?').run(
    JSON.stringify({message:{role:'assistant',content:'故事'.repeat(compress?7000:20)}}), 'assistant-0');
  if (input !== null && output !== null) {
    const row = db.prepare('SELECT usage_json FROM sessions WHERE id=?').get('session')!;
    const usage = JSON.parse(String(row.usage_json));
    usage.latestContext = {inputTokens:input,outputTokens:output,contextWindowTokens:32768,
      modelId:'fake',apiModelConfigId:'config',runId:'run-5',requestId:'last',finishedAt:1};
    db.prepare('UPDATE sessions SET usage_json=? WHERE id=?').run(JSON.stringify(usage), 'session');
  }
  let calls = 0;
  const gateway: ModelGateway = {
    resolve: () => model, supportsDirect:()=>true,
    stream: () => ({async *[Symbol.asyncIterator]() {
      calls++;
      yield {type:'text_delta',delta:'response',contentIndex:0,partial:{} as never} as AssistantMessageEvent;
      yield {type:'done',reason:'stop',message:{role:'assistant',content:[{type:'text',text:'response'}],
        api:'openai-completions',provider:'fake',model:'fake',usage:tokenUsage(100,20),stopReason:'stop',timestamp:Date.now()}} as AssistantMessageEvent;
    }}),
  };
  const credentials: CredentialStore = { async get() { return 'test'; }, async set() {}, deleteSync() {} };
  const { SRRuntime } = await import('../src/runtime/sr-runtime.js');
  const runtime = new SRRuntime(db, credentials, gateway);
  const {runId,stream} = await runtime.prepare('session','continue',randomUUID(),parent);
  const reader = stream.getReader();
  while (!(await reader.read()).done) { /* drain */ }
  expect(runtime.status('session',runId)?.status).toBe('completed');
  expect(calls > 1).toBe(compress);
  expect(Number(db.prepare("SELECT count(*) AS count FROM entries WHERE run_id=? AND type='compaction'").get(runId)?.count)).toBe(compress ? 1 : 0);
  db.close();
});

it('serves two Session dimensions through the server route and records real model usage for a Run', async () => {
  const db = seed();
  const gateway: ModelGateway = {
    resolve: () => model,
    supportsDirect:()=>true,
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
  const credentials: CredentialStore = { async get() { return 'test'; }, async set() {}, deleteSync() {} };
  db.prepare("UPDATE presets SET context_strategy=json_set(context_strategy,'$.max_context_tokens',16000) WHERE id='sr-default-preset'").run();
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
  expect(response.headers.get('cache-control')).toBe('no-store');
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
