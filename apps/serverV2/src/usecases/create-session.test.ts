import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, type JsonObject } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { EventHub, type SessionEvent } from '../infrastructure/events/event-hub.js';
import { createServices, type Services } from '../services.js';
import { createUsecases, type Usecases } from '../usecases.js';
import { narrativePreset } from '../testing/fixtures.js';
import { prepareContext, type ContextDependencies } from './context/index.js';
import type { ModelInfo } from '../infrastructure/model/client.js';
import { createSessionUsecase, type CreateSessionInput } from './create-session.js';

let db: DatabaseSync, dataRoot: string, services: Services, usecases: Usecases, events: EventHub;
const input: CreateSessionInput = { id: 'session', worldId: 'world', openingId: 'start', userCharacterId: 'player', presetId: 'preset', apiModelConfigId: 'model' };
const model: ModelInfo = {
  providerId: 'provider', modelId: 'model', name: 'Model', contextWindow: 64000, maxTokens: 8192,
  api: 'test', input: ['text'], reasoning: false, thinkingLevels: ['off'], thinkingLevelMap: null,
  promptCache: null, narrativeCompatible: true, supportsMidConversationSystemMessages: true,
};
const number = (key: string, initial: number) => ({ type: 'number', initial, min: 0, max: 100, description: key, rules: { [key]: 'Change with the story.' } });
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-create-session-'));
  services = createServices(db, dataRoot);
  events = new EventHub();
  usecases = createUsecases({ services, events, transaction: bindTransaction(db) });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'not-read-on-create' });
  services.worlds.create({
    id: 'world', name: 'World', specVersion: '0.1',
    characters: [{ id: 'player', name: '掌柜', player_selectable: true }, { id: 'npc', name: 'NPC' }],
    openings: [{ id: 'start', name: '夜归', content: '{{user}}，欢迎回来。{{user}}！', initial_state: { coins: 20, bag: { gold: 5 } } }],
    stateDefinition: { schema_version: 2, scopes: {
      global: { day: number('day', 1) },
      session: { visits: number('visits', 0) },
      message: { coins: number('coins', 1), energy: { ...number('energy', 5), load: { mode: 'never' } },
        bag: { type: 'json', initial: { gold: 1, items: [] }, description: 'Bag', rules: { bag: 'Bag', 'bag.gold': 'Gold', 'bag.items': 'Items', 'bag.items[]': 'Item' } } },
    } }, state: { day: 9 },
  });
});
afterEach(async () => { await usecases.narrative.shutdown(); vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

describe('create a ready session', () => {
  it('saves final content and complete local state, leaves global untouched, and emits once after commit', () => {
    const received: SessionEvent[] = [], order: string[] = [];
    const transaction = bindTransaction(db);
    const create = createSessionUsecase({ ...services, events, transaction: work => { const result = transaction(work); order.push('commit'); return result; } });
    const globalBefore = services.worlds.require('world');
    events.subscribe('session', () => { throw new Error('bad subscriber'); });
    events.subscribe('session', event => { received.push(event); order.push('event'); });
    const foreign = vi.fn(); events.subscribe('other', foreign);
    const result = create(input);
    expect(result.item).toMatchObject({ id: 'session', title: '夜归', tipEntryId: result.entry.id, state: { visits: 0 } });
    expect(result.entry).toMatchObject({ sessionId: 'session', seq: 1, parentId: null, type: 'message', role: 'assistant',
      payload: { message: { role: 'assistant', content: '掌柜，欢迎回来。掌柜！', timestamp: result.entry.timestamp } },
      state: [{ key: 'coins', value: 20 }, { key: 'energy', value: 5 }, { key: 'bag', value: { gold: 5 } }],
      metrics: null, extData: { narrative: { status: 'completed', finishedAt: result.entry.timestamp } } });
    expect(services.worlds.require('world')).toEqual(globalBefore);
    expect(order).toEqual(['commit', 'event']);
    expect(received).toEqual([{ event: 'session.created', data: { sessionId: 'session', tipEntryId: result.entry.id, timestamp: result.entry.timestamp, entry: result.entry } }]);
    expect(foreign).not.toHaveBeenCalled();
    expect(result.entry.extData).not.toHaveProperty('origin');
    expect(result.entry).not.toHaveProperty('kind');
    expect(usecases.narrative.list('session').items.find(item => item.runId === result.entry.runId)!).toMatchObject({ status: 'completed', finishedAt: result.entry.timestamp, entries: [result.entry] });
    expect(usecases.narrative.usage('session').recordedRequestCount).toBe(0);
  });

  it('substitutes every exact user placeholder once, keeping replacement syntax literal', () => {
    services.worlds.update('world', { characters: [{ id: 'player', name: '$&{{user}}', player_selectable: true }] });
    const result = usecases.createSession(input);
    expect(result.entry.payload.message).toMatchObject({ content: '$&{{user}}，欢迎回来。$&{{user}}！' });
    expect(services.worlds.requireOpening('world', 'start').content).toBe('{{user}}，欢迎回来。{{user}}！');
  });

  it('supports absent definitions and preserves an explicit null title', () => {
    services.worlds.update('world', { stateDefinition: null, openings: [{ id: 'start', name: 'Start', content: 'Hello' }] });
    const result = usecases.createSession({ ...input, title: null });
    expect(result.item.title).toBeNull();
    expect(result.item.state).toEqual({});
    expect(result.entry.state).toEqual([]);
  });

  it.each([
    { openingId: 'foreign' }, { userCharacterId: 'npc' }, { userCharacterId: 'missing' },
    { presetId: 'missing' }, { apiModelConfigId: 'missing' }, { worldId: 'missing' },
  ])('rejects invalid selections without a session or notification: %j', patch => {
    const publish = vi.spyOn(events, 'publish');
    expect(() => usecases.createSession({ ...input, ...patch })).toThrow();
    expect(services.sessions.get('session')).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects an absent opening and caller-supplied state at the usecase boundary', () => {
    const missing: Partial<CreateSessionInput> = { ...input };
    delete missing.openingId;
    expect(() => usecases.createSession(missing as CreateSessionInput)).toThrow();
    expect(() => usecases.createSession({ ...input, state: {} } as CreateSessionInput)).toThrow();
    expect(services.sessions.get('session')).toBeNull();
  });

  it.each([{ unknown: 1 }, { coins: 999 }, { bag: { surprise: true } }, { 'bag.gold': 1 }] as JsonObject[])('rejects invalid initial overrides: %j', initialState => {
    services.worlds.update('world', { openings: [{ id: 'start', name: 'Start', content: 'Hi', initial_state: initialState }] });
    const publish = vi.spyOn(events, 'publish');
    expect(() => usecases.createSession(input)).toThrow();
    expect(services.sessions.get('session')).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('rolls back both the session and first entry if saving its outcome fails', () => {
    const publish = vi.spyOn(events, 'publish');
    const persist = services.sessions.setNarrativeOutcome.bind(services.sessions);
    vi.spyOn(services.sessions, 'setNarrativeOutcome').mockImplementation((...args) => { persist(...args); throw new Error('save failed'); });
    expect(() => usecases.createSession(input)).toThrow('save failed');
    expect(services.sessions.get('session')).toBeNull();
    expect(db.prepare('SELECT count(*) AS count FROM entries').get()!.count).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(services.state.requireGlobal('world')).toEqual({ day: 9 });
  });

  it('does not duplicate a session, first entry or creation event for an existing id', () => {
    const publish = vi.spyOn(events, 'publish');
    const result = usecases.createSession(input);
    expect(() => usecases.createSession(input)).toThrow();
    expect(services.sessions.getHistory('session')).toEqual([result.entry]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('keeps runs unclassified and paginates the initial message as an ordinary group', () => {
    const result = usecases.createSession(input);
    for (let index = 0; index < 5; index++) services.sessions.appendEntry('session', {
      runId: 'run-' + index, type: 'message', role: 'assistant', payload: { text: 'Body' },
    });
    const first = usecases.narrative.list('session');
    expect(first.items).toHaveLength(5);
    expect(first.items.every(item => item.status === 'unknown' && !('kind' in item))).toBe(true);
    const last = usecases.narrative.list('session', { beforeSeq: first.nextBeforeSeq! });
    expect(last.items).toHaveLength(1);
    expect(last.items[0]).toMatchObject({ runId: result.entry.runId, status: 'completed' });
    expect(last.hasMore).toBe(false);
  });

  it('uses the saved first message and inherited state in the first player turn', async () => {
    const result = usecases.createSession(input);
    const user = services.sessions.appendEntry('session', { runId: 'next', type: 'message', role: 'user', payload: { message: { role: 'user', content: '进门', timestamp: 1 } } });
    const summarize = vi.fn<ContextDependencies['summarize']>(async () => ({ ok: false }));
    const context = await prepareContext({
      ...services, modelClient: { resolve: () => model, assertMessageOrder: vi.fn() }, summarize,
    }, {
      kind: 'narrative', sessionId: 'session', runId: user.runId, inputText: '进门',
      userEntryId: user.id, previousTipEntryId: result.entry.id, signal: new AbortController().signal,
    });
    expect(context.ok).toBe(true);
    if (!context.ok) throw new Error(context.failure.code);
    expect(context.parentEntryId).toBe(user.id);
    expect(context.request.messages.filter(message => message.role === 'assistant'))
      .toEqual([{ content: '掌柜，欢迎回来。掌柜！', role: 'assistant', timestamp: result.entry.timestamp }]);
    expect(context.request.activeRoots).toEqual(['coins', 'bag']);
    const instructions = context.request.messages.at(-1)!.content;
    expect(instructions).toContain('value: 20');
    expect(instructions).toContain('"gold":5');
    expect(services.state.getViews({ worldId: 'world', sessionId: 'session', entryId: user.id }))
      .toEqual({ global: { day: 9 }, session: { visits: 0 }, message: { coins: 20, energy: 5, bag: { gold: 5 } } });
    expect(services.state.requireMessage('session', user.id)).toEqual(result.entry.state);
    expect(summarize).not.toHaveBeenCalled();
  });
});
