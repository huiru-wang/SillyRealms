import { seedMessage } from '../../testing/run-fixtures.js';
import { worldPublication } from '../../testing/fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { bindTransaction } from '../../infrastructure/database/transaction.js';
import { EventHub, type SessionEvent } from '../../infrastructure/events/event-hub.js';
import type { ModelClient, ModelEvent, ModelInfo } from '../../infrastructure/model/client.js';
import type { CharacterSpriteOutput } from '../../modules/sessions/service.js';
import { createServices, type Services } from '../../services.js';
import { memoryCredentials } from '../../testing/credentials.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { createNarrativeUsecases, type AcceptedNarrative, type NarrativeUsecases } from './index.js';
import type { NarrativeTerminalEvent } from './events.js';

const model: ModelInfo = {
  providerId: 'provider', modelId: 'model', name: 'Model', contextWindow: 64000, maxTokens: 8192,
  api: 'test', input: ['text'], reasoning: false, thinkingLevels: ['off'], thinkingLevelMap: null,
  promptCache: null, supportsMidConversationSystemMessages: true,
};
const body = '三人走进大厅。';
const rows = [
  { position: 'left', characterId: 'alice', spriteId: 'default' },
  { position: 'center', characterId: 'bob', spriteId: 'default' },
  { position: 'right', characterId: 'carol', spriteId: 'default' },
] as const;
const assets = { alice: 'sr-asset://assets/alice.webp', bob: 'https://example.com/bob.webp', carol: 'https://example.com/carol.webp' };
const eventItems = rows.map(item => ({ ...item, asset: assets[item.characterId] }));
const block = (items: readonly unknown[] = rows) =>
  '<character_sprite>\n' + items.map(item => JSON.stringify(item)).join('\n') + '\n</character_sprite>';

let db: DatabaseSync, root: string, services: Services, hub: EventHub, narrative: NarrativeUsecases;
let seen: SessionEvent[], stream: ReturnType<typeof vi.fn<ModelClient['stream']>>;
beforeEach(async () => {
  db = openDatabase(':memory:');
  root = mkdtempSync(join(tmpdir(), 'sr-sprite-narrative-'));
  services = createServices(db, root, memoryCredentials());
  const credentialRef = services.credentials.referenceFor('model');
  await services.credentials.set(credentialRef, 'test-secret');
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef });
  const preset = narrativePreset();
  const nodes = preset.config.nodes.map(node => node.id === 'characterSprite'
    ? { ...node, prompt: '根据当前场景选择完整立绘快照。\n{{characterSprite.catalog}}' } : node);
  services.presets.create({ ...preset, id: 'preset', config: { ...preset.config, nodes } });
  services.worlds.create({
    id: 'world', specVersion: '0.2', publication: worldPublication(), name: 'World',
    characters: [
      { id: 'player', name: 'Player', player_selectable: true },
      ...Object.entries(assets).map(([id, asset]) => ({ id, name: id,
        sprites: [{ id: 'default', description: '日常站姿', asset }] })),
    ],
    openings: [{ id: 'opening', name: 'Opening', content: 'Opening' }],
  });
  services.sessions.create({ id: 'session', worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' },
    userCharacterId: 'player' });
  seedMessage(services, 'session', { id: 'opening', runId: 'opening-run', type: 'message', role: 'assistant',
    payload: { message: { role: 'assistant', content: 'Opening', timestamp: 1 } } });
  hub = new EventHub();
  seen = [];
  hub.subscribe('session', event => seen.push(structuredClone(event)));
  stream = vi.fn<ModelClient['stream']>();
  script(body + block());
  narrative = createNarrativeUsecases({
    ...services, events: hub, transaction: bindTransaction(db), logSink: () => {},
    modelClient: { resolve: () => model, assertMessageOrder: vi.fn(), stream },
  });
});
afterEach(async () => {
  await narrative.shutdown();
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function script(content: string, chunks: string[] = [], finishReason: 'stop' | 'length' = 'stop') {
  stream.mockImplementation(async function* (): AsyncGenerator<ModelEvent> {
    yield { type: 'request_started' };
    for (const text of chunks) yield { type: 'delta', delta: { content: text } };
    yield { type: 'done', finishReason,
      usage: { inputTokens: 25, outputTokens: 15, totalTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
      snapshot: { role: 'assistant', content, reasoning_content: '', tool_calls: [] } };
  });
}
function terminal(): Promise<NarrativeTerminalEvent> {
  return new Promise(resolve => {
    const unsubscribe = hub.subscribe('session', event => {
      if (event.event === 'run.completed' || event.event === 'run.stopped') {
        unsubscribe();
        resolve(event as NarrativeTerminalEvent);
      }
    });
  });
}
function submit() {
  const finished = terminal();
  const accepted = narrative.submit({ sessionId: 'session', input: { text: '继续' },
    expectedTipEntryId: services.sessions.require('session').tipEntryId });
  return { accepted, finished };
}
const saved = (accepted: AcceptedNarrative) => services.sessions.getEntry('session', accepted.assistantEntryId)!;
const spriteResult = (accepted: AcceptedNarrative): CharacterSpriteOutput | null =>
  services.sessions.getMessageCharacterSprites('session', accepted.assistantEntryId);
const changes = () => seen.filter(event => event.event === 'character_sprite.changed');

describe('character sprite narrative integration', () => {
  it('persists three characters before notifying, after unlock, and hides split protocol from public output', async () => {
    const raw = body + block();
    script(raw, [body + '<char', 'acter_spr', raw.slice(body.length + '<character_spr'.length)]);
    let committedAtEvent: CharacterSpriteOutput | null = null, unlocked = false;
    hub.subscribe('session', event => {
      if (event.event !== 'character_sprite.changed') return;
      committedAtEvent = services.sessions.getMessageCharacterSprites('session', event.data.messageId as string);
      try { services.cache.assertSessionWrite('session'); unlocked = true; } catch { unlocked = false; }
    });
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(spriteResult(accepted)).toEqual({ status: 'success', items: eventItems });
    expect(committedAtEvent).toEqual(spriteResult(accepted));
    expect(unlocked).toBe(true);
    expect(changes()).toEqual([{ event: 'character_sprite.changed', data: {
      sessionId: 'session', runId: accepted.runId, messageId: accepted.assistantEntryId, items: eventItems,
    } }]);
    expect(seen.slice(-3).map(event => event.event)).toEqual(['character_sprite.changed', 'run.usage', 'run.completed']);
    expect(saved(accepted).payload.message).toMatchObject({ content: body });
    expect(JSON.stringify(seen.filter(event => event.event === 'run.delta'))).not.toMatch(/character_sprite/);
    const request = stream.mock.calls[0]![1].map(message => message.content).join('\n');
    expect(request).toContain('<character_sprite></character_sprite>');
    expect(request).not.toContain('https://example.com/');
  });

  it('applies accepted rows as a full replacement without keeping earlier characters', async () => {
    const first = submit();
    await first.finished;
    seen = [];
    script(body + '<character_sprite>\n'
      + '{"position":"left","characterId":"alice","spriteId":"missing"}\n'
      + JSON.stringify(rows[1]) + '\n{"position":"center","characterId":"carol","spriteId":"default"}\n</character_sprite>');
    const second = submit();
    await second.finished;
    expect(spriteResult(second.accepted)).toEqual({
      status: 'partial_success', items: [eventItems[1]], errors: [
        { line: 1, errorCode: 'unknown_sprite' }, { line: 3, errorCode: 'duplicate_position' },
      ],
    });
    expect(changes()[0]?.data.items).toEqual([eventItems[1]]);
    expect(spriteResult(first.accepted)?.items).toEqual(eventItems);
  });

  it.each([
    { name: 'explicit empty', tail: '<character_sprite></character_sprite>', status: 'success', notify: true },
    { name: 'all rows invalid', tail: '<character_sprite>\nnot-json\n</character_sprite>', status: 'invalid_items', notify: false },
    { name: 'damaged tag', tail: '<character_sprite>{', status: 'invalid_tag', notify: false },
    { name: 'missing block', tail: '', status: undefined, notify: false },
  ])('handles $name without confusing absence, errors or clearing', async ({ tail, status, notify }) => {
    script(body + tail);
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    if (status === undefined) expect(spriteResult(accepted)).toBeNull();
    else expect(spriteResult(accepted)).toMatchObject({ status, items: [] });
    expect(changes()).toHaveLength(notify ? 1 : 0);
    if (notify) expect(changes()[0]?.data.items).toEqual([]);
  });

  it('parses actual output even when the preset node disables all sprite prompt and history injection', async () => {
    const current = services.presets.require('preset');
    services.presets.update('preset', { config: { ...current.config,
      nodes: current.config.nodes.map(node => node.id === 'characterSprite' ? { ...node, enabled: false } : node) } });
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(spriteResult(accepted)?.items).toEqual(eventItems);
    expect(changes()).toHaveLength(1);
    expect(JSON.stringify(stream.mock.calls[0]![1])).not.toContain('character_sprite');
  });

  it('adds empty history tags after a missing or failed result without changing saved output', async () => {
    for (const tail of ['', '<character_sprite>bad-json</character_sprite>']) {
      script(body + tail);
      const run = submit();
      await run.finished;
    }
    const originals = structuredClone(services.sessions.getHistory('session'));
    script(body);
    await submit().finished;
    const history = stream.mock.calls[2]![1].filter(message => message.role === 'assistant');
    expect(history).toHaveLength(3);
    expect(history[0]!.content).toBe('Opening');
    for (const message of history.slice(-2)) expect(message.content).toContain('<character_sprite></character_sprite>');
    for (const original of originals) {
      expect(services.sessions.getEntry('session', original.id)).toEqual(original);
    }
  });

  it('does not notify an uncommitted or interrupted snapshot', async () => {
    script(body + block(), [], 'length');
    const stopped = submit();
    expect((await stopped.finished).event).toBe('run.stopped');
    expect(saved(stopped.accepted).extData).not.toHaveProperty('output');
    expect(changes()).toHaveLength(0);
    script(body + block());
    vi.spyOn(services.sessions, 'settleRun').mockImplementationOnce(() => { throw new Error('save failed'); });
    const failed = submit();
    expect(await failed.finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'message_persist_failed' } });
    expect(services.sessions.getEntry('session', failed.accepted.assistantEntryId)).toBeNull();
    expect(changes()).toHaveLength(0);
  });

  it('rolls back sprite output and emits no change when settlement fails', async () => {
    vi.spyOn(services.sessions, 'settleRun').mockImplementationOnce(() => { throw new Error('outcome failed'); });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'message_persist_failed' } });
    expect(services.sessions.getRun('session', accepted.runId).capabilities).toEqual({});
    expect(changes()).toHaveLength(0);
  });

  it('still settles when delivering a sprite notification throws', async () => {
    const publish = hub.publish.bind(hub);
    vi.spyOn(hub, 'publish').mockImplementation((id, event) => {
      if (event.event === 'character_sprite.changed') throw new Error('delivery failed');
      publish(id, event);
    });
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(spriteResult(accepted)?.items).toEqual(eventItems);
    expect(seen.slice(-2).map(event => event.event)).toEqual(['run.usage', 'run.completed']);
  });

  it('regeneration deletes the old message and attaches the new full snapshot to a new message ID', async () => {
    const first = submit();
    await first.finished;
    script(body + block([rows[1]]));
    seen = [];
    const finished = terminal();
    const replacement = narrative.regenerate({ sessionId: 'session', runId: first.accepted.runId,
      expectedAssistantEntryId: first.accepted.assistantEntryId, expectedTipEntryId: first.accepted.assistantEntryId });
    expect((await finished).event).toBe('run.completed');
    expect(replacement.runId).toBe(first.accepted.runId);
    expect(replacement.assistantEntryId).not.toBe(first.accepted.assistantEntryId);
    expect(() => services.sessions.getMessageCharacterSprites('session', first.accepted.assistantEntryId)).toThrow('ENTRY_NOT_FOUND');
    expect(spriteResult(replacement)?.items).toEqual([eventItems[1]]);
    expect(seen.find(event => event.event === 'message.deleted')?.data.messageId).toBe(first.accepted.assistantEntryId);
    expect(changes()).toEqual([{ event: 'character_sprite.changed', data: {
      sessionId: 'session', runId: replacement.runId, messageId: replacement.assistantEntryId, items: [eventItems[1]],
    } }]);
  });
});

it('appends the saved state, suggestion and sprite rows to the previous assistant in the next actual model request', async () => {
  services.worlds.update('world', { stateDefinition:{schema_version:2,scopes:{message:{
    coins:{type:'number',initial:1,description:'Coins',rules:{coins:'Track spending'}},
  }}} });
  services.sessions.setEntryState('session','opening',[{key:'coins',value:1}]);
  script(body + '<state_update>\n{"path":"coins","value":3}\n</state_update>'
    + '<action_suggestions>["查看行囊"]</action_suggestions>' + block([rows[0]]));
  const first = submit();
  expect((await first.finished).event).toBe('run.completed');
  expect(saved(first.accepted).extData).toEqual({});
  expect(saved(first.accepted).payload.message).toMatchObject({content:body});
  expect(narrative.get('session', first.accepted.runId).capabilities).toMatchObject({
    stateUpdate:{status:'success'}, actionSuggestions:{status:'success'}, characterSprite:{items:[eventItems[0]]},
  });
  script('继续行走。');
  await submit().finished;
  const previous = stream.mock.calls[1]![1].find(message => message.role === 'assistant' && message.content.startsWith(body));
  expect(previous?.content).toBe([
    body, '', '<state_update>', '{"path":"coins","value":3}', '</state_update>',
    '<action_suggestions>["查看行囊"]</action_suggestions>', '<character_sprite>',
    JSON.stringify(rows[0]), '</character_sprite>',
  ].join('\n'));
});
