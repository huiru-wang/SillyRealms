import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database/connection.js';
import { SessionRepository, type AppendEntryInput, type EntryMetrics, type UpdateEntryInput, type UpdateSessionInput } from './repository.js';

let db: DatabaseSync, sessions: SessionRepository;
beforeEach(() => {
  db = openDatabase(':memory:');
  db.exec(
    "INSERT INTO api_model_configs VALUES('model','Model','provider','actual-model','credential-ref',1,1);" +
    "INSERT INTO presets VALUES('preset','narrative','Narrative',NULL,'{}',1,1);" +
    "INSERT INTO presets VALUES('image','image','Image',NULL,'{}',1,1);" +
    "INSERT INTO worlds(id,spec_version,name,characters_json,openings_json,state,created_at,updated_at) " +
    "VALUES('world','0.1','World','[]','[]','{}',1,1);",
  );
  sessions = new SessionRepository(db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

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
    db.prepare('UPDATE sessions SET state=? WHERE id=?').run('{"coins":7}', created.id);
    vi.mocked(Date.now).mockReturnValue(200);
    expect(sessions.update(created.id, { title: 'Renamed' })).toMatchObject({
      title: 'Renamed', state: { coins: 7 }, usage_json: null, created_at: 100, updated_at: 200,
    });
    expect(() => sessions.update(created.id, { state: {} } as unknown as UpdateSessionInput)).toThrow();
    expect(sessions.get('missing')).toBeNull();
  });

  it('rejects missing world/model and non-narrative defaults atomically', () => {
    const input = { id: 'bad', world_id: 'world', preset_id: 'preset', api_model_config_id: 'model', user_character_id: 'player' };
    expect(() => sessions.create({ ...input, world_id: 'missing' })).toThrow('WORLD_NOT_FOUND');
    expect(() => sessions.create({ ...input, api_model_config_id: 'missing' })).toThrow('MODEL_NOT_FOUND');
    expect(() => sessions.create({ ...input, preset_id: 'image' })).toThrow();
    expect(sessions.list()).toHaveLength(0);
    create();
    expect(() => sessions.update('session', { title: 'must rollback', preset_id: 'image' })).toThrow();
    expect(sessions.get('session')!.title).toBeNull();
  });

  it('lists by a stable updated-at/id cursor and cascades entries on deletion', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    create('a'); create('b'); create('c');
    const first = sessions.list({ world_id: 'world', limit: 2 });
    expect(first.map(value => value.id)).toEqual(['c', 'b']);
    expect(sessions.list({ before: { updated_at: 100, id: 'b' } }).map(value => value.id)).toEqual(['a']);
    append('a', 'entry');
    expect(() => db.prepare('DELETE FROM worlds WHERE id=?').run('world')).toThrow();
    expect(sessions.delete('a')).toBe(true);
    expect(sessions.getEntry('a', 'entry')).toBeNull();
    expect(sessions.delete('a')).toBe(false);
  });
});

describe('entry trees and field ownership', () => {
  it('keeps old branches and builds the active chain through compaction entries', () => {
    create();
    append('session', 'root', { run_id: 'opening' });
    append('session', 'user', { role: 'user' });
    append('session', 'answer');
    sessions.appendEntry('session', { id: 'summary', run_id: 'compact', type: 'compaction', role: null, payload: { summary: 'Earlier history' } });
    sessions.setTip('session', 'user');
    const branch = append('session', 'alternate', { run_id: 'retry' });
    expect(branch.seq).toBe(5);
    expect(sessions.getHistory('session').map(value => value.id)).toEqual(['root', 'user', 'alternate']);
    expect(sessions.getHistory('session', 'summary').map(value => value.id)).toEqual(['root', 'user', 'answer', 'summary']);
    expect(sessions.listEntries('session', { after_seq: 2, limit: 2 }).map(value => value.id)).toEqual(['answer', 'summary']);
    expect(sessions.listRunEntries('session', 'run').map(value => value.id)).toEqual(['user', 'answer']);
  });

  it('rejects cross-session parent/tip, additional roots, and corrupt cycles', () => {
    create('one'); create('two');
    append('one', 'root-one'); append('two', 'root-two');
    expect(() => append('one', 'cross', { parent_id: 'root-two' })).toThrow('INVALID_PARENT_CHAIN');
    expect(() => sessions.setTip('one', 'root-two')).toThrow('INVALID_PARENT_CHAIN');
    expect(() => append('one', 'new-root', { parent_id: null })).toThrow('INVALID_PARENT_CHAIN');
    expect(sessions.get('one')!.tip_entry_id).toBe('root-one');
    const child = append('one', 'child');
    db.prepare('UPDATE entries SET parent_id=? WHERE id=?').run(child.id, 'root-one');
    expect(() => sessions.getHistory('one')).toThrow('INVALID_PARENT_CHAIN');
    expect(() => append('one', 'corrupt')).toThrow('INVALID_PARENT_CHAIN');
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
    db.prepare('UPDATE api_model_configs SET model_id=? WHERE id=?').run('new-model', 'model');
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

  it('does not duplicate requests onto user entries or another branch/entry', () => {
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
