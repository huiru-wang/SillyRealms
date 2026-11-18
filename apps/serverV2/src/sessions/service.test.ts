import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database/connection.js';
import { createServices, type Services } from '../services.js';
import { narrativePreset } from '../testing/fixtures.js';
import { type SessionService, type AppendEntryInput, type EntryMetrics, type UpdateEntryInput, type UpdateSessionInput } from './service.js';

let db: DatabaseSync, services: Services, sessions: SessionService, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-session-service-'));
  services = createServices(db, dataRoot);
  services.models.create({ id: 'model', name: 'Model', provider_id: 'provider', model_id: 'actual-model', credential_ref: 'credential-ref' });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({ id: 'world', spec_version: '0.1', name: 'World', characters_json: [], openings_json: [] });
  sessions = services.sessions;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function create(id = 'session') {
  return sessions.create({ id, world_id: 'world', preset_id: 'preset', api_model_config_id: 'model', user_character_id: 'player' });
}
function append(sessionId: string, id: string, patch: Partial<AppendEntryInput> = {}) {
  return sessions.appendEntry(sessionId, {
    id, run_id: 'run', type: 'message', role: 'assistant', payload: { text: id }, ...patch,
  } as AppendEntryInput);
}
function metrics(id: string, usage: EntryMetrics['requests'][number]['usage'] = null): EntryMetrics {
  return { requests: [{ requestId: id, modelId: 'actual-model-snapshot', status: 'completed', usage, durationMs: 2500, firstTextMs: 180 }] };
}

describe('session records and references', () => {
  it('starts with no tip/usage and changes only the session-owned fields', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const created = create();
    expect(created).toMatchObject({ tip_entry_id: null, state: {}, usage_json: null, created_at: 100, updated_at: 100 });
    sessions.setState(created.id, { coins: 7 });
    vi.mocked(Date.now).mockReturnValue(200);
    expect(sessions.update(created.id, { title: 'Renamed' })).toMatchObject({
      title: 'Renamed', state: { coins: 7 }, usage_json: null, created_at: 100, updated_at: 200,
    });
    expect(() => sessions.update(created.id, { state: {} } as unknown as UpdateSessionInput)).toThrow();
    expect(sessions.get('missing')).toBeNull();
  });

  it('rejects missing world/model/preset references atomically', () => {
    const input = { id: 'bad', world_id: 'world', preset_id: 'preset', api_model_config_id: 'model', user_character_id: 'player' };
    expect(() => sessions.create({ ...input, world_id: 'missing' })).toThrow('WORLD_NOT_FOUND');
    expect(() => sessions.create({ ...input, api_model_config_id: 'missing' })).toThrow('MODEL_CONFIG_NOT_FOUND');
    expect(() => sessions.create({ ...input, preset_id: 'missing' })).toThrow('PRESET_NOT_FOUND');
    expect(sessions.list()).toHaveLength(0);
    create();
    expect(() => sessions.update('session', { title: 'must rollback', preset_id: 'missing' })).toThrow('PRESET_NOT_FOUND');
    expect(sessions.get('session')!.title).toBeNull();
  });

  it('lists by a stable updated-at/id cursor and cascades entries on deletion', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    create('a'); create('b'); create('c');
    const first = sessions.list({ world_id: 'world', limit: 2 });
    expect(first.map(value => value.id)).toEqual(['c', 'b']);
    expect(sessions.list({ before: { updated_at: 100, id: 'b' } }).map(value => value.id)).toEqual(['a']);
    append('a', 'entry');
    expect(() => services.worlds.delete('world')).toThrow();
    expect(sessions.delete('a')).toBe(true);
    expect(sessions.getEntry('a', 'entry')).toBeNull();
    expect(sessions.delete('a')).toBe(false);
  });
});

describe('linear history and field ownership', () => {
  it('advances one linear history through message and compaction entries', () => {
    create();
    expect(sessions.getHistory('session')).toEqual([]);
    append('session', 'root', { run_id: 'opening', parent_id: null });
    append('session', 'user', { role: 'user', parent_id: 'root' });
    append('session', 'answer');
    sessions.appendEntry('session', { id: 'summary', run_id: 'compact', type: 'compaction', role: null, payload: { summary: 'Earlier history' } });
    const continuation = append('session', 'continuation', { run_id: 'continue' });
    expect(continuation).toMatchObject({ seq: 5, parent_id: 'summary' });
    expect(sessions.get('session')!.tip_entry_id).toBe('continuation');
    expect(sessions.getHistory('session').map(value => value.id)).toEqual(['root', 'user', 'answer', 'summary', 'continuation']);
    expect(sessions.listEntries('session', { after_seq: 2, limit: 2 }).map(value => value.id)).toEqual(['answer', 'summary']);
    expect(sessions.listRunEntries('session', 'run').map(value => value.id)).toEqual(['user', 'answer']);
  });

  it('rejects stale, cross-session and null parents without moving the tip or consuming a sequence', () => {
    create('one'); create('two');
    append('one', 'root-one'); append('two', 'root-two');
    append('one', 'child');
    for (const parent_id of ['root-one', 'root-two', null]) {
      expect(() => append('one', 'invalid', { parent_id })).toThrow('TIP_CONFLICT');
      expect(sessions.get('one')!.tip_entry_id).toBe('child');
      expect(sessions.listEntries('one').map(entry => entry.id)).toEqual(['root-one', 'child']);
    }
    expect(append('one', 'next', { parent_id: 'child' }).seq).toBe(3);
  });

  it('rejects corrupt history and a persisted tip that no longer points at the last entry', () => {
    create();
    append('session', 'root');
    append('session', 'child');
    db.prepare('UPDATE entries SET parent_id=? WHERE id=?').run('child', 'root');
    expect(() => sessions.getHistory('session')).toThrow('INVALID_PARENT_CHAIN');
    expect(() => append('session', 'corrupt')).toThrow('INVALID_PARENT_CHAIN');
    db.prepare('UPDATE entries SET parent_id=NULL WHERE id=?').run('root');
    db.prepare('UPDATE sessions SET tip_entry_id=? WHERE id=?').run('root', 'session');
    expect(() => append('session', 'rewound')).toThrow('INVALID_PARENT_CHAIN');
    expect(sessions.listEntries('session')).toHaveLength(2);
  });

  it('rolls back failed entry insertion and does not consume a sequence or move the tip', () => {
    create();
    append('session', 'root');
    expect(() => append('session', 'root')).toThrow();
    expect(sessions.get('session')!.tip_entry_id).toBe('root');
    expect(sessions.listEntries('session')).toHaveLength(1);
    expect(append('session', 'next').seq).toBe(2);
  });

  it('changes payload/ext_data without overwriting snapshots, metrics, ancestry or display time', () => {
    create();
    const original = append('session', 'root', {
      timestamp: 42, state: [{ key: 'coins', value: 7 }],
      metrics_json: metrics('request'), ext_data: { actions: ['Wait'] },
    });
    const edited = sessions.updateEntry('session', 'root', { payload: { text: 'Edited' } });
    expect(edited).toMatchObject({
      parent_id: original.parent_id, timestamp: 42, state: original.state,
      metrics_json: original.metrics_json, ext_data: original.ext_data, payload: { text: 'Edited' },
    });
    expect(() => sessions.updateEntry('session', 'root', { state: [] } as unknown as UpdateEntryInput)).toThrow();
    expect(() => sessions.updateEntry('session', 'root', { parent_id: 'root' } as unknown as UpdateEntryInput)).toThrow();
  });
});

describe('one canonical metrics shape', () => {
  it('distinguishes absent metrics, unknown usage, and real zero consumption', () => {
    create(); append('session', 'assistant');
    expect(sessions.getEntry('session', 'assistant')!.metrics_json).toBeNull();
    expect(sessions.setMetrics('session', 'assistant', metrics('unknown')).metrics_json!.requests[0]!.usage).toBeNull();
    const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(sessions.setMetrics('session', 'assistant', metrics('zero', zero)).metrics_json!.requests[0]!.usage).toEqual(zero);
    services.models.update('model', { model_id: 'new-model' });
    expect(sessions.getEntry('session', 'assistant')!.metrics_json!.requests[0]!.modelId).toBe('actual-model-snapshot');
  });

  it('preserves normalized inclusive input and provider total without adding cache tokens again', () => {
    create(); append('session', 'assistant');
    const usage = { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cacheReadTokens: 600, cacheWriteTokens: 100 };
    expect(sessions.setMetrics('session', 'assistant', metrics('cached', usage)).metrics_json!.requests[0]!.usage).toEqual(usage);
    expect(() => sessions.setMetrics('session', 'assistant', metrics('invalid', { ...usage, inputTokens: 20 }))).toThrow();
    const missing = metrics('missing', usage);
    delete (missing.requests[0]!.usage as unknown as Record<string, unknown>).outputTokens;
    expect(() => sessions.setMetrics('session', 'assistant', missing)).toThrow();
    expect(sessions.getEntry('session', 'assistant')!.metrics_json!.requests[0]!.requestId).toBe('cached');
  });

  it('does not duplicate requests onto user entries or another entry', () => {
    create();
    append('session', 'root', { metrics_json: metrics('request') });
    append('session', 'user', { role: 'user' });
    expect(() => sessions.setMetrics('session', 'user', metrics('request'))).toThrow('USER_ENTRY_METRICS_NOT_ALLOWED');
    expect(() => append('session', 'copy', { metrics_json: metrics('request') })).toThrow('DUPLICATE_REQUEST_METRICS');
    expect(sessions.get('session')!.tip_entry_id).toBe('user');
    append('session', 'answer');
    sessions.setMetrics('session', 'answer', metrics('other'));
    expect(() => sessions.setMetrics('session', 'answer', { requests: [...metrics('duplicate').requests, ...metrics('duplicate').requests] })).toThrow();
    expect(sessions.getEntry('session', 'answer')!.metrics_json!.requests[0]!.requestId).toBe('other');
  });

  it('stores compaction metrics and updates only metadata time, with strict terminal/numeric fields', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    create();
    const entry = sessions.appendEntry('session', { id: 'summary', run_id: 'compact', type: 'compaction', role: null, payload: { summary: 'Summary' } });
    vi.mocked(Date.now).mockReturnValue(200);
    const saved = sessions.setMetrics('session', 'summary', metrics('summary-request'));
    expect(saved.timestamp).toBe(entry.timestamp);
    expect(saved.updated_at).toBe(200);
    expect(sessions.get('session')!.updated_at).toBe(100);
    for (const patch of [{ durationMs: -1 }, { durationMs: Infinity }, { status: 'started' }, { phase: 'summary' }]) {
      const invalid = { requests: [{ ...metrics('invalid').requests[0], ...patch }] } as unknown as EntryMetrics;
      expect(() => sessions.setMetrics('session', 'summary', invalid)).toThrow();
    }
  });
});
