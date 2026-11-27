import { worldPublication } from '../../testing/fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors.js';
import type { RunWritePermit } from '../../infrastructure/cache/index.js';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { bindTransaction } from '../../infrastructure/database/transaction.js';
import { EventHub } from '../../infrastructure/events/event-hub.js';
import type { ModelClient, ModelEvent, ModelInfo } from '../../infrastructure/model/client.js';
import { createServices, type Services } from '../../services.js';
import { memoryCredentials } from '../../testing/credentials.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { createStateUsecase, type StateUsecase } from '../state.js';
import type { NarrativeTerminalEvent } from './events.js';
import { createNarrativeUsecases, type NarrativeUsecases } from './index.js';

const model: ModelInfo = {
  modelId: 'story-model', name: 'Story', providerId: 'test-provider', api: 'openai-completions',
  reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 8192,
  thinkingLevels: ['off'], thinkingLevelMap: null, promptCache: null,
  supportsMidConversationSystemMessages: false,
};
const usage = { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 };
const snapshot = { role: 'assistant' as const, content: 'Saved answer', reasoning_content: '', tool_calls: [] };
const done = (): ModelEvent => ({ type: 'done', snapshot, finishReason: 'stop', usage });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

let db: DatabaseSync, dataRoot: string, services: Services, events: EventHub;
let narrative: NarrativeUsecases, stateUsecase: StateUsecase;
let stream: ReturnType<typeof vi.fn<ModelClient['stream']>>;
let resolveModel: ReturnType<typeof vi.fn<ModelClient['resolve']>>;
let permits: RunWritePermit[], gates: ReturnType<typeof deferred>[];

beforeEach(async () => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-write-locks-'));
  services = createServices(db, dataRoot, memoryCredentials());
  permits = []; gates = [];
  const credentialRef = services.credentials.referenceFor('model');
  await services.credentials.set(credentialRef, 'test-secret');
  services.models.create({ id: 'model', name: 'Model', providerId: model.providerId, modelId: model.modelId, credentialRef });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  createWorld('world');
  createSession('session');
  events = new EventHub();
  stream = vi.fn<ModelClient['stream']>(async function* () {
    yield { type: 'request_started' };
    yield done();
  });
  resolveModel = vi.fn<ModelClient['resolve']>(() => model);
  const shared = { ...services, events, transaction: bindTransaction(db) };
  narrative = createNarrativeUsecases({
    ...shared, modelClient: { resolve: resolveModel, assertMessageOrder: vi.fn(), stream }, logSink: () => {},
  });
  stateUsecase = createStateUsecase(shared);
});

afterEach(async () => {
  await narrative.shutdown();
  for (const gate of gates) gate.resolve();
  for (const permit of permits) services.cache.releaseRun(permit);
  vi.restoreAllMocks();
  db.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

function createWorld(id: string) {
  return services.worlds.create({
    id, name: id, specVersion: '0.2', publication: worldPublication(), state: { day: 1 },
    characters: [{ id: 'player', name: 'Player', player_selectable: true }],
    openings: [{ id: 'start', name: 'Start', content: 'Opening' }],
  });
}
function createSession(id: string, worldId = 'world') {
  return services.sessions.create({
    id, worldId, runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player', state: { coins: 2 },
  });
}
function append(id: string, role: 'user' | 'assistant', sessionId = 'session') {
  return services.sessions.appendEntry(sessionId, {
    id, runId: 'saved', type: 'message', role, payload: { message: { role, content: id, timestamp: 100 } },
  });
}
function acquire(sessionId = 'session', worldId = 'world') {
  const permit = services.cache.acquireRun({ sessionId, worldId, runId: 'held-' + sessionId });
  permits.push(permit);
  return permit;
}
function hold() {
  const gate = deferred();
  gates.push(gate);
  return gate;
}
function submit(text = 'Input') {
  const accepted = narrative.submit({
    sessionId: 'session', input: { text }, expectedTipEntryId: services.sessions.require('session').tipEntryId,
  });
  const finished = new Promise<NarrativeTerminalEvent>(resolve => {
    const unsubscribe = events.subscribe('session', event => {
      if (event.data.runId === accepted.runId && (event.event === 'run.completed' || event.event === 'run.stopped')) {
        unsubscribe();
        resolve(event as NarrativeTerminalEvent);
      }
    });
  });
  return { accepted, finished };
}
function expectWritable() {
  expect(() => services.sessions.update('session', { title: 'Unlocked' })).not.toThrow();
  expect(() => services.sessions.setState('session', { coins: 3 })).not.toThrow();
  expect(() => services.worlds.setState('world', { day: 2 })).not.toThrow();
}

describe('run write locks across session and state operations', () => {
  it('blocks every external session/state mutation, including empty patches and unchanged values', () => {
    append('user', 'user'); append('assistant', 'assistant');
    const before = services.sessions.getHistory('session');
    acquire();
    const sessionWrites: [string, () => unknown][] = [
      ['update', () => services.sessions.update('session', { title: 'Blocked' })],
      ['empty update', () => services.sessions.update('session', {})],
      ['delete', () => services.sessions.delete('session')],
      ['appendEntry', () => append('blocked', 'assistant')],
      ['appendNarrativeAssistant', () => services.sessions.appendNarrativeAssistant('session', {
        id: 'blocked-narrative', runId: 'blocked', type: 'message', role: 'assistant', payload: { text: 'Blocked' },
      }, { stateUpdate: { status: 'no_updates', updates: [] }, actionSuggestions: { status: 'no_suggestions', items: [] } })],
      ['setNarrativeOutcome', () => services.sessions.setNarrativeOutcome('session', 'user', { status: 'completed', finishedAt: 123 })],
      ['updateEntry', () => services.sessions.updateEntry('session', 'assistant', { payload: { text: 'Blocked' } })],
      ['empty entry update', () => services.sessions.updateEntry('session', 'assistant', {})],
    ];
    for (const [name, write] of sessionWrites) expect(write, name).toThrow(new AppError('SESSION_WRITE_LOCKED'));

    const stateWrites: [string, () => unknown][] = [
      ['sessions.setState', () => services.sessions.setState('session', { coins: 2 })],
      ['sessions.setEntryState', () => services.sessions.setEntryState('session', 'assistant', null)],
      ['worlds.setState', () => services.worlds.setState('world', { day: 1 })],
      ['empty global update', () => stateUsecase.update({ scope: 'global', worldId: 'world' }, [])],
      ['empty session update', () => stateUsecase.update({ scope: 'session', sessionId: 'session' }, [])],
      ['empty message update', () => stateUsecase.update({ scope: 'message', sessionId: 'session', entryId: 'assistant' }, [])],
      ['unchanged global update', () => stateUsecase.update({ scope: 'global', worldId: 'world' }, [{ path: 'day', value: 1 }])],
      ['unchanged session update', () => stateUsecase.update({ scope: 'session', sessionId: 'session' }, [{ path: 'coins', value: 2 }])],
      ['missing path message update', () => stateUsecase.update({ scope: 'message', sessionId: 'session', entryId: 'assistant' }, [{ path: 'absent', value: 1 }])],
    ];
    for (const [name, write] of stateWrites) expect(write, name).toThrow(new AppError('STATE_WRITE_LOCKED'));
    expect(services.sessions.getHistory('session')).toEqual(before);
    expect(services.state.getSession('session')).toEqual({ coins: 2 });
    expect(services.state.getGlobal('world')).toEqual({ day: 1 });
  });

  it('keeps other sessions/worlds writable and holds shared global state until every world run releases', () => {
    createSession('other-session');
    createWorld('other-world'); createSession('elsewhere', 'other-world');
    const first = acquire();
    expect(() => services.sessions.update('other-session', { title: 'Allowed' })).not.toThrow();
    expect(services.sessions.setState('other-session', { coins: 7 })).toEqual({ coins: 7 });
    expect(append('other-entry', 'assistant', 'other-session').sessionId).toBe('other-session');
    expect(services.sessions.setEntryState('other-session', 'other-entry', [{ key: 'coins', value: 4 }])).toEqual([{ key: 'coins', value: 4 }]);
    expect(services.worlds.setState('other-world', { day: 3 })).toEqual({ day: 3 });
    expect(() => services.sessions.update('elsewhere', { title: 'Allowed' })).not.toThrow();
    const second = acquire('other-session');
    services.cache.releaseRun(first);
    expect(() => services.sessions.update('session', { title: 'Released' })).not.toThrow();
    expect(() => services.worlds.setState('world', { day: 4 })).toThrow(new AppError('STATE_WRITE_LOCKED'));
    services.cache.releaseRun(second);
    expect(services.worlds.setState('world', { day: 4 })).toEqual({ day: 4 });
  });

  it('locks immediately at acceptance while allowing reads and stop, then releases after cancellation settlement', async () => {
    const entered = deferred(), held = hold();
    stream.mockImplementation(async function* () {
      yield { type: 'request_started' };
      entered.resolve();
      await held.promise;
      yield done();
    });
    const run = submit();
    expect(() => services.sessions.update('session', {})).toThrow(new AppError('SESSION_WRITE_LOCKED'));
    expect(() => stateUsecase.update({ scope: 'session', sessionId: 'session' }, [])).toThrow(new AppError('STATE_WRITE_LOCKED'));
    await entered.promise;
    expect(narrative.list('session').activeRunId).toBe(run.accepted.runId);
    expect(narrative.list('session').items.find(item => item.runId === run.accepted.runId)!.status).toBe('running');
    expect(narrative.usage('session').recordedRequestCount).toBe(0);
    expect(services.sessions.getHistory('session').map(entry => entry.id)).toEqual([run.accepted.userEntryId]);
    expect(services.state.getSession('session')).toEqual({ coins: 2 });
    expect(services.state.getGlobal('world')).toEqual({ day: 1 });
    expect(narrative.stop('session', run.accepted.runId, run.accepted.assistantEntryId)).toEqual({ runId: run.accepted.runId, assistantEntryId: run.accepted.assistantEntryId, stopping: true });
    expect(() => services.sessions.setState('session', {})).toThrow(new AppError('STATE_WRITE_LOCKED'));
    expect(await run.finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'cancelled' } });
    expect(narrative.list('session').activeRunId).toBeNull();
    expectWritable();
  });

  it.each(['completed', 'provider failure', 'preparation failure'] as const)('releases session and global locks after %s', async outcome => {
    if (outcome === 'provider failure') stream.mockImplementation(async function* () {
      yield { type: 'request_started' };
      yield { type: 'error', snapshot, stopReason: 'provider_error', usage };
    });
    if (outcome === 'preparation failure') resolveModel.mockImplementationOnce(() => { throw new AppError('MODEL_NOT_FOUND'); });
    const run = submit();
    expect(() => services.worlds.setState('world', {})).toThrow(new AppError('STATE_WRITE_LOCKED'));
    expect(await run.finished).toMatchObject({
      event: outcome === 'completed' ? 'run.completed' : 'run.stopped',
      data: { runId: run.accepted.runId },
    });
    const entries = services.sessions.listEntryRuns('session').items.find(item => item.runId === run.accepted.runId)!.entries;
    expect(entries[0]!.extData.narrative).toMatchObject({ status: outcome === 'completed' ? 'completed' : 'stopped' });
    if (outcome === 'completed') {
      expect(entries).toHaveLength(2);
      expect(entries[1]!.extData.output).toBeDefined();
      expect(entries[1]!.metrics!.context!.contextWindowTokens).toBe(model.contextWindow);
    }
    expectWritable();
  });

  it('releases admission and global state when initial user persistence fails', async () => {
    vi.spyOn(services.sessions, 'appendEntry').mockImplementationOnce(() => { throw new AppError('STORAGE_BUSY'); });
    expect(() => submit()).toThrow(new AppError('STORAGE_BUSY'));
    expect(narrative.list('session').activeRunId).toBeNull();
    expectWritable();
    expect((await submit().finished).event).toBe('run.completed');
  });

  it.each(['run.usage', 'run.completed'] as const)('does not let the old finalizer unlock a run submitted by a %s observer', async eventName => {
    const enteredNext = deferred(), held = hold();
    stream.mockImplementation(async function* (_model, messages) {
      yield { type: 'request_started' };
      if (messages.filter(message => message.role === 'user').at(-1)?.content === 'Next') {
        enteredNext.resolve();
        await held.promise;
      }
      yield done();
    });
    let firstId = '', next: ReturnType<typeof submit> | undefined, startError: unknown;
    events.subscribe('session', event => {
      if (event.event === eventName && event.data.runId === firstId) {
        try { next = submit('Next'); }
        catch (error) { startError = error; }
      }
    });
    const first = submit('First');
    firstId = first.accepted.runId;
    expect((await first.finished).event).toBe('run.completed');
    expect(startError).toBeUndefined();
    expect(next).toBeDefined();
    await enteredNext.promise;
    // The first settlement's finalizer has had a turn while the second model request is pending.
    await Promise.resolve();
    expect(narrative.list('session').activeRunId).toBe(next!.accepted.runId);
    expect(() => services.sessions.update('session', {})).toThrow(new AppError('SESSION_WRITE_LOCKED'));
    expect(() => stateUsecase.update({ scope: 'session', sessionId: 'session' }, [])).toThrow(new AppError('STATE_WRITE_LOCKED'));
    expect(() => stateUsecase.update({ scope: 'global', worldId: 'world' }, [])).toThrow(new AppError('STATE_WRITE_LOCKED'));
    held.resolve();
    expect((await next!.finished).event).toBe('run.completed');
    expectWritable();
  });
});
