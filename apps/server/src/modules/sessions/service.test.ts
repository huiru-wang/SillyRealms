import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { createServices, type Services } from '../../services.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { type SessionService, type AppendEntryInput, type EntryMetrics, type UpdateEntryInput, type UpdateSessionInput } from './service.js';

let db: DatabaseSync, services: Services, sessions: SessionService, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-session-service-'));
  services = createServices(db, dataRoot);
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'actual-model', credentialRef: 'credential-ref' });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({ id: 'world', specVersion: '0.1', name: 'World', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });
  sessions = services.sessions;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function create(id = 'session') {
  return sessions.create({ id, worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' });
}
function append(sessionId: string, id: string, patch: Partial<AppendEntryInput> = {}) {
  return sessions.appendEntry(sessionId, {
    id, runId: 'run', type: 'message', role: 'assistant', payload: { text: id }, ...patch,
  } as AppendEntryInput);
}
function metrics(id: string, usage: EntryMetrics['requests'][number]['usage'] = null): EntryMetrics {
  return { requests: [{ requestId: id, modelId: 'actual-model-snapshot', provider: 'test-provider', usage, durationMs: 2500, firstTextMs: 180 }] };
}

describe('session records and references', () => {
  it('starts with no tip/usage and changes only the session-owned fields', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const created = create();
    expect(created).toMatchObject({ tipEntryId: null, state: {}, usage: null, createdAt: 100, updatedAt: 100 });
    expect(Object.keys(created).sort()).toEqual([
      'apiModelConfigId', 'createdAt', 'id', 'presetId', 'state', 'tipEntryId', 'title', 'updatedAt', 'usage', 'userCharacterId', 'worldId',
    ]);
    sessions.setState(created.id, { coins: 7 });
    vi.mocked(Date.now).mockReturnValue(200);
    expect(sessions.update(created.id, { title: 'Renamed' })).toMatchObject({
      title: 'Renamed', state: { coins: 7 }, usage: null, createdAt: 100, updatedAt: 200,
    });
    expect(() => sessions.update(created.id, { state: {} } as unknown as UpdateSessionInput)).toThrow();
    expect(sessions.get('missing')).toBeNull();
  });

  it('validates the selected player and keeps identity fixed after creation', () => {
    expect(() => sessions.create({ worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'npc' })).toThrow('INVALID_SESSION_CHARACTER');
    expect(sessions.list()).toEqual([]);
    const created = create();
    expect(() => sessions.update(created.id, { userCharacterId: 'npc' } as never)).toThrow();
    expect(sessions.require(created.id).userCharacterId).toBe('player');
  });

  it('rejects missing world/model/preset references atomically', () => {
    const input = { id: 'bad', worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' };
    expect(() => sessions.create({ ...input, worldId: 'missing' })).toThrow('WORLD_NOT_FOUND');
    expect(() => sessions.create({ ...input, apiModelConfigId: 'missing' })).toThrow('MODEL_CONFIG_NOT_FOUND');
    expect(() => sessions.create({ ...input, presetId: 'missing' })).toThrow('PRESET_NOT_FOUND');
    expect(sessions.list()).toHaveLength(0);
    create();
    expect(() => sessions.update('session', { title: 'must rollback', presetId: 'missing' })).toThrow('PRESET_NOT_FOUND');
    expect(sessions.get('session')!.title).toBeNull();
  });

  it('counts requested worlds in one service operation, including zero counts', () => {
    services.worlds.create({ id: 'other', specVersion: '0.1', name: 'Other', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });
    create('one'); create('two');
    sessions.create({ id: 'three', worldId: 'other', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' });
    expect(sessions.countByWorldIds(['world', 'other', 'missing', 'world'])).toEqual({ world: 2, other: 1, missing: 0 });
    expect(sessions.countByWorldIds(['other'])).toEqual({ other: 1 });
    expect(sessions.countByWorldIds([])).toEqual({});
    sessions.delete('one');
    expect(sessions.countByWorldIds(['world'])).toEqual({ world: 1 });
    expect(() => sessions.countByWorldIds([' world'])).toThrow();
  });

  it('lists by a stable updated-at/id cursor and cascades entries on deletion', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    create('a'); create('b'); create('c');
    const first = sessions.list({ worldId: 'world', limit: 2 });
    expect(first.map(value => value.id)).toEqual(['c', 'b']);
    expect(sessions.listPage({ worldId: 'world', limit: 2 })).toEqual({ items: first, hasMore: true });
    expect(sessions.listPage({ before: { updatedAt: 100, id: 'b' }, limit: 2 }).hasMore).toBe(false);
    expect(sessions.list({ before: { updatedAt: 100, id: 'b' } }).map(value => value.id)).toEqual(['a']);
    append('a', 'entry');
    await expect(services.worlds.delete('world')).rejects.toThrow();
    expect(sessions.delete('a')).toBe(true);
    expect(sessions.getEntry('a', 'entry')).toBeNull();
    expect(sessions.delete('a')).toBe(false);
  });
});

describe('linear history and field ownership', () => {
  it('advances one linear history through message and compaction entries', () => {
    create();
    expect(sessions.getHistory('session')).toEqual([]);
    append('session', 'root', { runId: 'opening', parentId: null });
    append('session', 'user', { role: 'user', parentId: 'root' });
    append('session', 'answer');
    sessions.appendEntry('session', { id: 'summary', runId: 'compact', type: 'compaction', role: null, payload: { summary: 'Earlier history' } });
    const continuation = append('session', 'continuation', { runId: 'continue' });
    expect(continuation).toMatchObject({ seq: 5, parentId: 'summary' });
    expect(sessions.get('session')!.tipEntryId).toBe('continuation');
    expect(sessions.getHistory('session').map(value => value.id)).toEqual(['root', 'user', 'answer', 'summary', 'continuation']);
    expect(sessions.listEntryRuns('session').items.find(item => item.runId === 'run')!.entries.map(value => value.id)).toEqual(['user', 'answer']);
  });

  it('rejects stale, cross-session and null parents without moving the tip or consuming a sequence', () => {
    create('one'); create('two');
    append('one', 'root-one'); append('two', 'root-two');
    append('one', 'child');
    for (const parentId of ['root-one', 'root-two', null]) {
      expect(() => append('one', 'invalid', { parentId })).toThrow('TIP_CONFLICT');
      expect(sessions.get('one')!.tipEntryId).toBe('child');
      expect(sessions.getHistory('one').map(entry => entry.id)).toEqual(['root-one', 'child']);
    }
    expect(append('one', 'next', { parentId: 'child' }).seq).toBe(3);
  });

  it('reads linear history by seq and validates the current tip without traversing earlier parents', () => {
    create();
    append('session', 'root');
    append('session', 'child');
    db.prepare('UPDATE entries SET parent_id=? WHERE id=?').run('child', 'root');
    expect(sessions.getHistory('session').map(entry => entry.id)).toEqual(['root', 'child']);
    expect(append('session', 'next').seq).toBe(3);
    db.prepare('UPDATE entries SET parent_id=NULL WHERE id=?').run('root');
    db.prepare('UPDATE sessions SET tip_entry_id=? WHERE id=?').run('root', 'session');
    expect(() => append('session', 'rewound')).toThrow('INVALID_PARENT_CHAIN');
    expect(sessions.getHistory('session').map(entry => entry.id)).toEqual(['root']);
  });

  it('rolls back failed entry insertion and does not consume a sequence or move the tip', () => {
    create();
    append('session', 'root');
    expect(() => append('session', 'root')).toThrow();
    expect(sessions.get('session')!.tipEntryId).toBe('root');
    expect(sessions.getHistory('session')).toHaveLength(1);
    expect(append('session', 'next').seq).toBe(2);
  });

  it('changes payload/extData without overwriting snapshots, metrics, ancestry or display time', () => {
    create();
    const original = append('session', 'root', {
      timestamp: 42, state: [{ key: 'coins', value: 7 }],
      metrics: metrics('request'), extData: { actions: ['Wait'] },
    });
    const edited = sessions.updateEntry('session', 'root', { payload: { text: 'Edited' } });
    expect(edited).toMatchObject({
      parentId: original.parentId, timestamp: 42, state: original.state,
      metrics: original.metrics, extData: original.extData, payload: { text: 'Edited' },
    });
    expect(() => sessions.updateEntry('session', 'root', { state: [] } as unknown as UpdateEntryInput)).toThrow();
    expect(() => sessions.updateEntry('session', 'root', { parentId: 'root' } as unknown as UpdateEntryInput)).toThrow();
  });
});

describe('public assistant snapshots', () => {
  it.each([
    {
      name: 'body, reasoning and tool request', content: 'Visible answer', reasoning_content: 'Public reasoning',
      tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"海港"}' } }],
    },
    { name: 'reasoning only', content: '', reasoning_content: 'Partial reasoning', tool_calls: [] },
    {
      name: 'partial tool request only', content: '', reasoning_content: '',
      tool_calls: [{ index: 0, id: '', type: 'function', function: { name: '', arguments: '{"query":' } }],
    },
  ])('round-trips $name without interpreting tool arguments or changing earlier messages', ({ content, reasoning_content, tool_calls }) => {
    create();
    const user = sessions.appendEntry('session', {
      id: 'user', runId: 'run', type: 'message', role: 'user',
      payload: { message: { role: 'user', content: 'Existing input', timestamp: 99 } },
    });
    const message = { role: 'assistant', content, reasoning_content, tool_calls, timestamp: 100 };
    const payload = { message: structuredClone(message) };
    const saved = sessions.appendEntry('session', {
      id: 'assistant', parentId: 'user', runId: 'run', type: 'message', role: 'assistant',
      timestamp: 100, payload: { message },
    });
    message.content = 'Caller mutation';
    message.reasoning_content = 'Caller mutation';
    expect(saved.payload).toEqual(payload);
    expect(sessions.getEntry('session', 'assistant')!.payload).toEqual(payload);
    expect(sessions.getHistory('session').map(entry => entry.payload)).toEqual([user.payload, payload]);
    expect(sessions.require('session').tipEntryId).toBe('assistant');
  });

  it('reserves standalone tool-result roles without storing entries or moving the tip', () => {
    create();
    expect(() => sessions.appendEntry('session', {
      id: 'tool-result', runId: 'run', type: 'message', role: 'tool',
      payload: { message: { role: 'tool', tool_call_id: 'call-1', content: 'Result' } },
    } as unknown as AppendEntryInput)).toThrow();
    expect(sessions.getHistory('session')).toEqual([]);
    expect(sessions.require('session').tipEntryId).toBeNull();
  });
});

describe('one canonical metrics shape', () => {
  it('distinguishes absent metrics, unknown usage, and real zero consumption', () => {
    create(); append('session', 'assistant');
    expect(sessions.getEntry('session', 'assistant')!.metrics).toBeNull();
    expect(sessions.setMetrics('session', 'assistant', metrics('unknown')).metrics!.requests[0]!.usage).toBeNull();
    const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(sessions.setMetrics('session', 'assistant', metrics('zero', zero)).metrics!.requests[0]!.usage).toEqual(zero);
    services.models.update('model', { modelId: 'new-model' });
    expect(sessions.getEntry('session', 'assistant')!.metrics!.requests[0]!.modelId).toBe('actual-model-snapshot');
  });

  it('preserves normalized inclusive input and provider total without adding cache tokens again', () => {
    create(); append('session', 'assistant');
    const usage = { inputTokens: 1200, outputTokens: 300, totalTokens: 1500, cacheReadTokens: 600, cacheWriteTokens: 100 };
    expect(sessions.setMetrics('session', 'assistant', metrics('cached', usage)).metrics!.requests[0]!.usage).toEqual(usage);
    expect(() => sessions.setMetrics('session', 'assistant', metrics('invalid', { ...usage, inputTokens: 20 }))).toThrow();
    const missing = metrics('missing', usage);
    delete (missing.requests[0]!.usage as unknown as Record<string, unknown>).outputTokens;
    expect(() => sessions.setMetrics('session', 'assistant', missing)).toThrow();
    expect(sessions.getEntry('session', 'assistant')!.metrics!.requests[0]!.requestId).toBe('cached');
  });

  it('does not duplicate requests onto user entries or another entry', () => {
    create();
    append('session', 'root', { metrics: metrics('request') });
    append('session', 'user', { role: 'user' });
    expect(() => sessions.setMetrics('session', 'user', metrics('request'))).toThrow('USER_ENTRY_METRICS_NOT_ALLOWED');
    expect(() => append('session', 'copy', { metrics: metrics('request') })).toThrow('DUPLICATE_REQUEST_METRICS');
    expect(sessions.get('session')!.tipEntryId).toBe('user');
    append('session', 'answer');
    sessions.setMetrics('session', 'answer', metrics('other'));
    expect(() => sessions.setMetrics('session', 'answer', { requests: [...metrics('duplicate').requests, ...metrics('duplicate').requests] })).toThrow();
    expect(sessions.getEntry('session', 'answer')!.metrics!.requests[0]!.requestId).toBe('other');
  });

  it('stores compaction metrics and updates only metadata time, with strict terminal/numeric fields', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    create();
    const entry = sessions.appendEntry('session', { id: 'summary', runId: 'compact', type: 'compaction', role: null, payload: { summary: 'Summary' } });
    vi.mocked(Date.now).mockReturnValue(200);
    const saved = sessions.setMetrics('session', 'summary', metrics('summary-request'));
    expect(saved.timestamp).toBe(entry.timestamp);
    expect(saved.updatedAt).toBe(200);
    expect(sessions.get('session')!.updatedAt).toBe(100);
    for (const patch of [{ durationMs: -1 }, { durationMs: Infinity }, { status: 'started' }, { phase: 'summary' }]) {
      const invalid = { requests: [{ ...metrics('invalid').requests[0], ...patch }] } as unknown as EntryMetrics;
      expect(() => sessions.setMetrics('session', 'summary', invalid)).toThrow();
    }
  });
});

describe('run pages, outcomes and recorded usage', () => {
  it('pages exactly five complete runs backwards, including runs with more than two entries', () => {
    create();
    for (let run = 1; run <= 12; run++) {
      for (let message = 0; message < (run === 8 ? 3 : 2); message++) {
        append('session', `${run}-${message}`, { runId: `r${run}`, role: message === 0 ? 'user' : 'assistant' });
      }
    }
    const narrow = sessions.listEntryRuns('session', { limit: 1 });
    expect(narrow.items.map(item => item.runId)).toEqual(['r12']);
    expect(sessions.listEntryRuns('session', { limit: 2, beforeSeq: narrow.nextBeforeSeq! }).items.map(item => item.runId)).toEqual(['r11', 'r10']);
    const latest = sessions.listEntryRuns('session');
    expect(latest.items.map(item => item.runId)).toEqual(['r12', 'r11', 'r10', 'r9', 'r8']);
    expect(latest.items.at(-1)!.entries).toHaveLength(3);
    const older = sessions.listEntryRuns('session', { beforeSeq: latest.nextBeforeSeq! });
    expect(older.items.map(item => item.runId)).toEqual(['r7', 'r6', 'r5', 'r4', 'r3']);
    const oldest = sessions.listEntryRuns('session', { beforeSeq: older.nextBeforeSeq! });
    expect(oldest.items.map(item => item.runId)).toEqual(['r2', 'r1']);
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextBeforeSeq).toBeNull();
  });

  it('finds a newly saved assistant in an already seen run and advances through five-run batches', () => {
    create();
    const user = append('session', 'user', { role: 'user', runId: 'first' });
    const assistant = append('session', 'assistant', { runId: 'first' });
    for (let n = 0; n < 6; n++) append('session', `later-${n}`, { runId: `later-${n}` });
    const page = sessions.listEntryRuns('session', { afterSeq: user.seq });
    expect(page.items).toHaveLength(5);
    expect(page.items[0]).toMatchObject({ runId: 'first', firstSeq: user.seq, lastSeq: assistant.seq });
    expect(page.items[0]!.entries.map(entry => entry.id)).toEqual(['user', 'assistant']);
    expect(page.hasMore).toBe(true);
    const next = sessions.listEntryRuns('session', { afterSeq: page.nextAfterSeq! });
    expect(next.items.map(item => item.runId)).toEqual(['later-4', 'later-5']);
    expect(next.hasMore).toBe(false);
    expect(sessions.listEntryRuns('session', { afterSeq: next.nextAfterSeq! }).items).toEqual([]);
  });

  it('keeps pages scoped to a session and does not skip interleaved run groups on forward reads', () => {
    create(); create('other');
    append('other', 'foreign', { runId: 'r1' });
    append('session', 'early', { runId: 'r1', role: 'user' });
    for (let n = 0; n < 6; n++) append('session', `middle-${n}`, { runId: `r${n + 2}` });
    append('session', 'late', { runId: 'r1' });
    const first = sessions.listEntryRuns('session', { afterSeq: 0 });
    const second = sessions.listEntryRuns('session', { afterSeq: first.nextAfterSeq! });
    expect([...first.items, ...second.items].map(item => item.runId)).toEqual(['r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r1']);
    expect(second.items.at(-1)!.entries.map(entry => entry.id)).toEqual(['early', 'late']);
    expect(() => sessions.listEntryRuns('session', { beforeSeq: 2, afterSeq: 1 })).toThrow();
  });

  it('protects narrative outcome from generic edits while preserving caller-owned extensions', () => {
    create();
    const user = append('session', 'user', { role: 'user', extData: { note: 'keep' } });
    const outcome = { status: 'stopped' as const, stopReason: 'cancelled' as const, finishedAt: 123 };
    const saved = sessions.setNarrativeOutcome('session', user.id, outcome);
    expect(saved.extData).toEqual({ note: 'keep', narrative: outcome });
    expect(saved.seq).toBe(user.seq);
    expect(sessions.updateEntry('session', user.id, { extData: { label: 'new' } }).extData)
      .toEqual({ label: 'new', narrative: outcome });
    expect(() => sessions.updateEntry('session', user.id, { extData: { narrative: outcome } })).toThrow();
    expect(() => append('session', 'forged', { extData: { narrative: outcome } })).toThrow();
    const assistant = append('session', 'assistant');
    expect(() => sessions.setNarrativeOutcome('session', assistant.id, outcome)).toThrow();
    expect(sessions.getNarrativeOutcome(saved)).toEqual(outcome);
    expect(sessions.getNarrativeOutcome(assistant)).toBeNull();
  });

  it('reads the latest saved main-request snapshot without using compaction or rebuilding missing metadata', () => {
    create();
    expect(sessions.recordedUsage('session').latestContext).toBeNull();
    const known = { inputTokens: 120, outputTokens: 20, totalTokens: 140, cacheReadTokens: 30, cacheWriteTokens: 0 };
    const main: EntryMetrics = {
      requests: [{ requestId: 'main', modelId: 'actual-model', provider: 'provider', usage: known }],
      context: {
        requestId: 'main', apiModelConfigId: 'model', contextWindowTokens: 64000,
        contextComposition: { systemBytes: 300, summaryBytes: 50, historyBytes: 200 },
      },
    };
    append('session', 'answer', { metrics: main });
    sessions.appendEntry('session', {
      id: 'summary', runId: 'next', type: 'compaction', role: null, payload: { summary: 'Saved summary' },
      metrics: metrics('summary', { ...known, inputTokens: 500, totalTokens: 520 }),
    });
    expect(sessions.getEntry('session', 'answer')!.metrics).toEqual(main);
    expect(sessions.recordedUsage('session')).toMatchObject({
      recordedRequestCount: 2, unknownUsageRequestCount: 0,
      latestContext: {
        inputTokens: 120, contextWindowTokens: 64000, modelId: 'actual-model', stale: false,
        contextComposition: main.context!.contextComposition,
      },
    });
    append('session', 'next-answer', { metrics: {
      requests: [{ requestId: 'unknown', modelId: 'actual-model', provider: 'provider', usage: null }],
    } });
    expect(sessions.recordedUsage('session').latestContext).toEqual({
      inputTokens: null, contextWindowTokens: null, modelId: 'actual-model', stale: false,
    });
  });

  it('marks a saved snapshot stale when its owner is off-chain or the selected configuration/model changes', () => {
    create();
    append('session', 'opening');
    append('session', 'answer', { metrics: {
      requests: [{ requestId: 'main', modelId: 'actual-model', provider: 'provider', usage: null }],
      context: {
        requestId: 'main', apiModelConfigId: 'model', contextWindowTokens: 64000,
        contextComposition: { systemBytes: 300, summaryBytes: 0, historyBytes: 200 },
      },
    } });
    append('session', 'later-input', { role: 'user', runId: 'later' });
    sessions.update('session', { title: 'Rename' });
    expect(sessions.recordedUsage('session').latestContext).toMatchObject({ inputTokens: null, stale: false });
    services.models.update('model', { modelId: 'different-model' });
    expect(sessions.recordedUsage('session').latestContext!.stale).toBe(true);
    services.models.update('model', { modelId: 'actual-model', providerId: 'other-provider' });
    expect(sessions.recordedUsage('session').latestContext!.stale).toBe(true);
    services.models.update('model', { providerId: 'provider' });
    services.models.create({ id: 'same-model-elsewhere', name: 'Other', providerId: 'provider', modelId: 'actual-model', credentialRef: 'other-ref' });
    sessions.update('session', { apiModelConfigId: 'same-model-elsewhere' });
    expect(sessions.recordedUsage('session').latestContext!.stale).toBe(true);
    sessions.update('session', { apiModelConfigId: 'model' });
    expect(sessions.recordedUsage('session').latestContext!.stale).toBe(false);
    // Exercise the read-side stale marker for a disconnected persisted record, without adding rollback support.
    db.prepare('UPDATE sessions SET tip_entry_id=? WHERE id=?').run('opening', 'session');
    expect(sessions.recordedUsage('session').latestContext!.stale).toBe(true);
  });

  it('validates snapshot ownership and keeps the actual latest request unknown instead of borrowing an older snapshot', () => {
    create();
    const main: EntryMetrics = {
      requests: [{ requestId: 'main', modelId: 'actual-model', provider: 'provider', usage: null }],
      context: {
        requestId: 'main', apiModelConfigId: 'model', contextWindowTokens: 64000,
        contextComposition: { systemBytes: 300, summaryBytes: 0, historyBytes: 200 },
      },
    };
    append('session', 'answer', { metrics: main });
    expect(() => sessions.setMetrics('session', 'answer', { ...main, context: { ...main.context!, requestId: 'not-recorded' } })).toThrow();
    expect(() => sessions.setMetrics('session', 'answer', { ...main, context: { ...main.context!, contextWindowTokens: 0 } })).toThrow();
    expect(() => sessions.setMetrics('session', 'answer', { ...main, context: {
      ...main.context!, contextComposition: { systemBytes: -1, summaryBytes: 0, historyBytes: 0 },
    } })).toThrow();
    sessions.setMetrics('session', 'answer', {
      ...main, requests: [...main.requests, { requestId: 'later', modelId: 'actual-model', provider: 'provider', usage: null }],
    });
    expect(sessions.recordedUsage('session').latestContext).toEqual({
      inputTokens: null, contextWindowTokens: null, modelId: 'actual-model', stale: false,
    });
  });

  it('normalizes legacy request status without guessing the provider and only totals recorded usage', () => {
    create();
    const known = { inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadTokens: 3, cacheWriteTokens: 0 };
    append('session', 'legacy');
    db.prepare('UPDATE entries SET metrics_json=? WHERE id=?').run(JSON.stringify({ requests: [{
      requestId: 'old', modelId: 'old-model', status: 'failed', usage: known,
    }] }), 'legacy');
    append('session', 'new', { metrics: metrics('new') });
    const request = sessions.getEntry('session', 'legacy')!.metrics!.requests[0]!;
    expect(request).toEqual({ requestId: 'old', modelId: 'old-model', provider: null, usage: known });
    expect(sessions.recordedUsage('session')).toEqual({
      knownUsage: known, recordedRequestCount: 2, unknownUsageRequestCount: 1,
      latestContext: { inputTokens: null, contextWindowTokens: null, modelId: 'actual-model-snapshot', stale: true },
    });
    expect(sessions.getEntry('session', 'new')!.metrics!.requests[0]!.provider).toBe('test-provider');
    expect(() => sessions.setMetrics('session', 'new', { requests: [{
      ...metrics('bad').requests[0]!, status: 'completed',
    }] } as unknown as EntryMetrics)).toThrow();
  });
});

describe('server-owned narrative output', () => {
  const output = (): import('./service.js').NarrativeOutput => ({
    stateUpdate: {
      status: 'partial_success',
      updates: [
        { path: 'coins', value: 8, reason: 'Bought food', status: 'success' },
        { status: 'invalid_json', errorCode: 'STATE_UPDATE_JSON_INVALID' },
      ],
    },
    actionSuggestions: {
      status: 'partial_success',
      items: ['Ask the keeper.', 'Leave.'],
    },
  });

  function save(value = output()) {
    return sessions.appendNarrativeAssistant('session', {
      id: 'assistant', runId: 'run', parentId: null, type: 'message', role: 'assistant',
      payload: { message: { role: 'assistant', content: 'Clean story' } },
      state: [{ key: 'coins', value: 8 }], extData: { note: 'keep' }, metrics: metrics('output-request'),
    }, value);
  }

  it('saves the clean message, partial results, state and metrics together as one entry', () => {
    create();
    const value = output();
    const expected = structuredClone(value);
    const saved = save(value);
    value.actionSuggestions.items.length = 0;
    value.stateUpdate.updates[0]!.value = 999;
    expect(saved).toMatchObject({
      seq: 1, payload: { message: { role: 'assistant', content: 'Clean story' } },
      state: [{ key: 'coins', value: 8 }], extData: { note: 'keep', output: expected },
      metrics: metrics('output-request'),
    });
    expect(sessions.getEntry('session', saved.id)!.extData.output).toEqual(expected);
    expect(sessions.require('session').tipEntryId).toBe(saved.id);
    expect(sessions.getHistory('session')).toHaveLength(1);
  });

  it('protects output during public append and editing, preserving other server-owned metadata', () => {
    create();
    const saved = save();
    sessions.setNarrativeOutcome('session', saved.id, { status: 'completed', finishedAt: 1 });
    expect(() => append('session', 'forged', { extData: { output: output() } })).toThrow();
    expect(() => sessions.updateEntry('session', saved.id, { extData: { output: null } })).toThrow();
    expect(() => sessions.updateEntry('session', saved.id, { extData: { output: output() } })).toThrow();
    const changed = sessions.updateEntry('session', saved.id, {
      payload: { message: { role: 'assistant', content: 'Edited story' } },
      extData: { label: 'changed' },
    });
    expect(changed.extData).toEqual({
      label: 'changed', output: output(), narrative: { status: 'completed', finishedAt: 1 },
    });
    expect(changed.state).toEqual(saved.state);
    expect(changed.metrics).toEqual(saved.metrics);
    expect(changed.seq).toBe(saved.seq);
    expect(sessions.getHistory('session')).toHaveLength(1);
  });

  it('rejects invalid result data before advancing the tip or consuming a sequence', () => {
    create();
    const malformed = output();
    malformed.stateUpdate.updates[0]!.value = Number.NaN;
    expect(() => save(malformed)).toThrow();
    expect(() => save({ ...output(), stateUpdate: { ...output().stateUpdate, status: 'fail' } } as never)).toThrow();
    const misplaced = { ...output(), contextEligible: true };
    expect(() => save(misplaced as never)).toThrow();
    expect(sessions.require('session').tipEntryId).toBeNull();
    expect(sessions.getHistory('session')).toEqual([]);
    expect(save().seq).toBe(1);
  });

  it('rejects removed duplicate result lists and success rows without values', () => {
    create();
    const value = output();
    expect(() => save({ ...value, actionSuggestions: { ...value.actionSuggestions, results: [] } } as never)).toThrow();
    expect(() => save({ ...value, stateUpdate: { ...value.stateUpdate, results: [] } } as never)).toThrow();
    expect(() => save({ ...value, stateUpdate: { status: 'success', updates: [{ status: 'success', path: 'coins' }] } } as never)).toThrow();
    expect(save().extData.output).toEqual(value);
  });

  it('projects legacy output by result order, preserving repeated paths and reasons without rewriting storage', () => {
    create();
    append('session', 'legacy');
    const legacy = {
      note: 'keep',
      output: {
        stateUpdate: {
          status: 'partial_success',
          updates: [{ path: 'coins', value: 8, reason: 'Bought food' }, { path: 'coins', value: 9, reason: 'Refund' }],
          results: [
            { status: 'invalid_json', errorCode: 'STATE_UPDATE_JSON_INVALID' },
            { status: 'success', path: 'coins' },
            { status: 'invalid_value', path: 'coins', errorCode: 'STATE_VALUE_INVALID', statePath: 'coins', rulePath: 'min' },
            { status: 'success', path: 'coins' },
          ],
        },
        actionSuggestions: {
          status: 'partial_success', items: ['Ask the keeper.'],
          results: [{ status: 'success' }, { status: 'empty_suggestion', errorCode: 'ACTION_SUGGESTION_EMPTY' }],
        },
      },
    };
    const encoded = JSON.stringify(legacy);
    db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(encoded, 'legacy');
    const expected = {
      note: 'keep', output: {
        stateUpdate: { status: 'partial_success', updates: [
          { status: 'invalid_json', errorCode: 'STATE_UPDATE_JSON_INVALID' },
          { status: 'success', path: 'coins', value: 8, reason: 'Bought food' },
          { status: 'invalid_value', path: 'coins', errorCode: 'STATE_VALUE_INVALID', statePath: 'coins', rulePath: 'min' },
          { status: 'success', path: 'coins', value: 9, reason: 'Refund' },
        ] },
        actionSuggestions: { status: 'partial_success', items: ['Ask the keeper.'] },
      },
    };
    for (const entry of [
      sessions.getEntry('session', 'legacy'),
      sessions.getHistory('session')[0],
      sessions.listEntryRuns('session').items[0]!.entries[0],
    ]) expect(entry!.extData).toEqual(expected);
    expect(db.prepare('SELECT ext_data FROM entries WHERE id=?').get('legacy')!.ext_data).toBe(encoded);
    expect(sessions.updateEntry('session', 'legacy', { payload: { text: 'Edited' } }).extData).toEqual(expected);
    expect(db.prepare('SELECT ext_data FROM entries WHERE id=?').get('legacy')!.ext_data).toBe(encoded);
  });

  it('does not turn incomplete legacy state receipts into success or disturb action output', () => {
    create();
    append('session', 'legacy');
    db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(JSON.stringify({ output: {
      stateUpdate: { status: 'success', updates: [], results: [{ status: 'success', path: 'coins' }] },
      actionSuggestions: { status: 'success', items: ['Continue.'], results: [{ status: 'success' }] },
    } }), 'legacy');
    expect(sessions.getEntry('session', 'legacy')!.extData.output).toEqual({
      stateUpdate: { status: 'invalid_updates', updates: [{ status: 'processing_error', errorCode: 'STATE_UPDATE_STORED_RESULT_INVALID' }] },
      actionSuggestions: { status: 'success', items: ['Continue.'] },
    });
  });

  it('only accepts assistant message carriers and leaves old messages without fabricated output', () => {
    create();
    for (const kind of [
      { type: 'message' as const, role: 'user' as const },
      { type: 'compaction' as const, role: null },
    ]) {
      expect(() => sessions.appendNarrativeAssistant('session', {
        id: 'bad', runId: 'run', payload: {}, ...kind,
      }, output())).toThrow();
    }
    const old = append('session', 'old');
    expect(old.extData).not.toHaveProperty('output');
    expect(sessions.getHistory('session')[0]!.extData).not.toHaveProperty('output');
    expect(sessions.updateEntry('session', old.id, { extData: {} }).extData).not.toHaveProperty('output');
  });

  it('records optional empty results without manufacturing an error or action', () => {
    create();
    const empty: import('./service.js').NarrativeOutput = {
      stateUpdate: { status: 'no_updates', updates: [] },
      actionSuggestions: { status: 'no_suggestions', items: [] },
    };
    expect(save(empty).extData.output).toEqual(empty);
  });
});

describe('generic entry deletion', () => {
  it('reconnects direct successors, inherits message state and does not clear the round outcome', () => {
    create();
    append('session','user',{role:'user',state:[{key:'coins',value:5}]});
    append('session','assistant',{state:[{key:'coins',value:3}],metrics:metrics('old')});
    append('session','summary',{type:'compaction',role:null,payload:{summary:'S'}});
    sessions.setNarrativeOutcome('session','user',{status:'completed',finishedAt:12});
    expect(sessions.deleteEntry('session','assistant','summary')).toMatchObject({entry:{id:'assistant'},tipEntryId:'summary'});
    expect(sessions.getEntry('session','summary')!.parentId).toBe('user');
    expect(services.state.getCurrentMessage('session')).toEqual({coins:5});
    expect(sessions.getNarrativeOutcome(sessions.getEntry('session','user')!)).toEqual({status:'completed',finishedAt:12});
    expect(sessions.recordedUsage('session').recordedRequestCount).toBe(0);
    expect(sessions.deleteEntry('session','summary','summary').tipEntryId).toBe('user');
    expect(sessions.deleteEntry('session','user','user').tipEntryId).toBeNull();
    expect(sessions.getHistory('session')).toEqual([]);
  });
  it('rejects mismatched tips, foreign entries and writes without the exact active permit', () => {
    create();create('other');append('session','a');append('other','foreign');
    expect(()=>sessions.deleteEntry('session','a',null)).toThrow('TIP_CONFLICT');
    expect(()=>sessions.deleteEntry('session','foreign','a')).toThrow('ENTRY_NOT_FOUND');
    const permit=services.cache.acquireRun({sessionId:'session',worldId:'world',runId:'run'});
    expect(()=>sessions.deleteEntry('session','a','a')).toThrow('SESSION_WRITE_LOCKED');
    expect(sessions.getEntry('session','a')).not.toBeNull();
    expect(sessions.deleteEntry('session','a','a',permit).tipEntryId).toBeNull();
    services.cache.releaseRun(permit);
  });
});
