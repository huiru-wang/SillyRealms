import { expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { Context } from '@earendil-works/pi-ai';
import { createApp } from '../src/app.js';
import { defaultPreset } from '../src/domain/preset/schema.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { updatePreset } from '../src/repositories/preset-repository.js';
import { presetFingerprint } from '../src/runtime/config.js';
import { estimateInitial, inputIdentity } from '../src/runtime/context/compaction/estimator.js';
import { fakeCredentials } from './fixtures/db-seed.js';
import { drain, response, runtimeFixture, tail, testModel, textGateway } from './fixtures/runtime-v2.js';

const request = (body: unknown, method = 'POST', etag?: string) => ({
  method, headers: { 'content-type': 'application/json', ...(etag ? { 'If-Match': etag } : {}) },
  body: JSON.stringify(body),
});

it.each([false, true])('round trips thinking=%s through import, save, read, export and create', async enabled => {
  const db = openDatabase(':memory:'), app = createApp(db, fakeCredentials);
  try {
    const preset = defaultPreset();
    preset.model_parameters = { temperature: 0.4, thinking_enabled: enabled };
    const imported = await app.request('/api/v1/presets/import', request(preset));
    expect(imported.status).toBe(201);
    const item = (await imported.json() as any).data.item;
    const path = '/api/v1/presets/' + item.id;
    const read = (await (await app.request(path)).json() as any).data.item;
    expect(read.model_parameters).toEqual(preset.model_parameters);
    expect(JSON.parse(String(db.prepare('SELECT model_parameters FROM presets WHERE id=?').get(item.id)!.model_parameters)))
      .toEqual(preset.model_parameters);

    const changed = { temperature: 0.6, thinking_enabled: !enabled };
    const saved = await app.request(path, request({ model_parameters: changed }, 'PATCH', read.etag));
    expect(saved.status).toBe(200);
    expect((await (await app.request(path)).json() as any).data.item.model_parameters).toEqual(changed);
    expect(JSON.parse(String(db.prepare('SELECT model_parameters FROM presets WHERE id=?').get(item.id)!.model_parameters)))
      .toEqual(changed);
    const exported = await (await app.request(path + '/export')).json() as any;
    expect(exported.model_parameters).toEqual(changed);
    const created = await app.request('/api/v1/presets', request(exported));
    expect(created.status).toBe(201);
    expect((await created.json() as any).data.item.model_parameters).toEqual(changed);
  } finally { db.close(); }
});

it('reads existing JSON without the flag as false and writes the default only on save', async () => {
  const db = openDatabase(':memory:'), app = createApp(db, fakeCredentials);
  const path = '/api/v1/presets/sr-default-preset';
  try {
    const oldParameters = JSON.stringify({ temperature: 0.3 });
    db.prepare('UPDATE presets SET model_parameters=? WHERE id=?').run(oldParameters, 'sr-default-preset');
    const read = (await (await app.request(path)).json() as any).data.item;
    expect(read.model_parameters).toEqual({ temperature: 0.3, thinking_enabled: false });
    expect(db.prepare('SELECT model_parameters FROM presets WHERE id=?').get(read.id)!.model_parameters).toBe(oldParameters);
    expect((await (await app.request(path + '/export')).json() as any).model_parameters)
      .toEqual({ temperature: 0.3, thinking_enabled: false });

    const saved = await app.request(path, request({ description: 'Save existing preset' }, 'PATCH', read.etag));
    expect(saved.status).toBe(200);
    expect(JSON.parse(String(db.prepare('SELECT model_parameters FROM presets WHERE id=?').get(read.id)!.model_parameters)))
      .toEqual({ temperature: 0.3, thinking_enabled: false });

    const imported = await app.request('/api/v1/presets/import',
      request({ ...defaultPreset(), model_parameters: { temperature: 0.2 } }));
    expect(imported.status).toBe(201);
    expect((await imported.json() as any).data.item.model_parameters)
      .toEqual({ temperature: 0.2, thinking_enabled: false });
  } finally { db.close(); }
});

it.each([null, 1, 'true'])('rejects non-boolean thinking_enabled=%s without changing a preset', async value => {
  const db = openDatabase(':memory:'), app = createApp(db, fakeCredentials);
  const path = '/api/v1/presets/sr-default-preset';
  try {
    const before = (await (await app.request(path)).json() as any).data.item;
    const result = await app.request(path, request({
      model_parameters: { ...before.model_parameters, thinking_enabled: value },
    }, 'PATCH', before.etag));
    expect(result.status).toBe(422);
    const after = (await (await app.request(path)).json() as any).data.item;
    expect(after.etag).toBe(before.etag);
    expect(after.model_parameters).toEqual(before.model_parameters);
  } finally { db.close(); }
});

it.each([
  { enabled: false, modelReasoning: true, expected: undefined },
  { enabled: true, modelReasoning: true, expected: 'medium' },
  { enabled: true, modelReasoning: false, expected: undefined },
] as const)('freezes thinking=$enabled for a model with reasoning=$modelReasoning through preview and generation',
  async ({ enabled, modelReasoning, expected }) => {
    const gateway = textGateway('Story.' + tail());
    gateway.resolve = () => ({ ...testModel, reasoning: modelReasoning });
    const streamed: Array<{ reasoning?: string; temperature?: number }> = [];
    const previews: Array<{ reasoning?: string; temperature?: number }> = [];
    const stream = gateway.stream;
    gateway.stream = (model, context, options) => {
      streamed.push({ reasoning: options.reasoning, temperature: options.temperature });
      return stream(model, context, options);
    };
    const { db, runtime, preset } = runtimeFixture(gateway);
    try {
      preset.model_parameters = { temperature: 0.35, thinking_enabled: enabled };
      updatePreset(db, 'sr-default-preset', preset);
      gateway.preview = async (model, context, options) => {
        expect(Object.isFrozen(model)).toBe(true);
        expect(Object.isFrozen(context)).toBe(true);
        previews.push({ reasoning: options.reasoning, temperature: options.temperature });
        // A preset edited after preparation starts must affect only the next Run.
        updatePreset(db, 'sr-default-preset', { ...preset,
          model_parameters: { temperature: 0.9, thinking_enabled: !enabled } });
        return undefined;
      };
      const run = await runtime.prepare('session', 'Continue.', 'thinking-generation', 'opening');
      await drain(run.stream);
      expect(runtime.status('session', run.runId)?.status).toBe('completed');
      expect(previews).toEqual([{ reasoning: expected, temperature: 0.35 }]);
      expect(streamed).toEqual(previews);
    } finally { db.close(); }
  });

function appendOldHistory(db: DatabaseSync): string {
  let parent = 'opening', seq = 2;
  for (let i = 1; i <= 6; i++) for (const role of ['user', 'assistant']) {
    const id = 'thinking-old-' + role + '-' + i;
    const text = role === 'assistant' && i === 1 ? 'H'.repeat(12000) : role + ' ' + i;
    db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)')
      .run(id, 'session', parent, 'thinking-old-run-' + i, seq++, 'message', role, 1, 1,
        JSON.stringify({ message: { role, content: text } }), JSON.stringify({ run: { status: 'completed' } }));
    parent = id;
  }
  db.prepare('UPDATE sessions SET tip_entry_id=? WHERE id=?').run(parent, 'session');
  return parent;
}

it.each([false, true])('uses thinking=%s consistently for summary and narrative requests', async enabled => {
  const gateway = textGateway('unused');
  gateway.resolve = () => ({ ...testModel, reasoning: true, contextWindow: 8192 });
  const previews: Array<{ maxTokens: number; reasoning?: string }> = [];
  const streamed: Array<{ maxTokens: number; reasoning?: string }> = [];
  gateway.preview = async (_model, _context, options) => {
    previews.push({ maxTokens: options.maxTokens, reasoning: options.reasoning });
    return undefined;
  };
  gateway.stream = (_model, _context, options) => ({ async *[Symbol.asyncIterator]() {
    streamed.push({ maxTokens: options.maxTokens, reasoning: options.reasoning });
    yield { type: 'done' as const, reason: 'stop' as const,
      message: response(options.maxTokens === 2048 ? 'Earlier story summary.' : 'Story.' + tail()) };
  } });
  const { db, runtime, preset } = runtimeFixture(gateway);
  try {
    preset.model_parameters.thinking_enabled = enabled;
    updatePreset(db, 'sr-default-preset', preset);
    const tip = appendOldHistory(db);
    const run = await runtime.prepare('session', 'Continue.', 'thinking-summary', tip);
    await drain(run.stream);
    expect(runtime.status('session', run.runId)?.status).toBe('completed');
    const reasoning = enabled ? 'medium' : undefined;
    expect(previews).toEqual([{ maxTokens: 2048, reasoning }, { maxTokens: 128, reasoning }]);
    expect(streamed).toEqual(previews);
  } finally { db.close(); }
});

it('invalidates preset and usage-baseline fingerprints when thinking changes', () => {
  const preset = defaultPreset(), before = presetFingerprint(preset);
  preset.model_parameters.thinking_enabled = true;
  expect(presetFingerprint(preset)).not.toBe(before);
  const model = { ...testModel, reasoning: true };
  const context: Context = { messages: [{ role: 'user', content: 'Continue.', timestamp: 0 }] };
  const identity = inputIdentity(model, context, { strategy: 'rolling_summary' });
  const baseline = { ...identity, inputTokens: 100 };
  expect(estimateInitial(context, identity, baseline).method).toBe('usage_plus_estimate');
  const thinking = inputIdentity(model, context, { strategy: 'rolling_summary', reasoning: 'medium' });
  expect(estimateInitial(context, thinking, baseline).method).toBe('full_estimate');
});
