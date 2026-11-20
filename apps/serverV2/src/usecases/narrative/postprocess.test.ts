import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { bindTransaction } from '../../infrastructure/database/transaction.js';
import { EventHub, type SessionEvent } from '../../infrastructure/events/event-hub.js';
import type { ModelClient, ModelEvent, ModelInfo, ModelUsage } from '../../infrastructure/model/client.js';
import type { NarrativeOutput } from '../../modules/sessions/service.js';
import { createServices, type Services } from '../../services.js';
import { memoryCredentials } from '../../testing/credentials.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { createNarrativeUsecases, type AcceptedNarrative, type NarrativeUsecases } from './index.js';
import type { NarrativeTerminalEvent } from './events.js';
import * as suggestions from './postprocess/action-suggestions.js';

const model: ModelInfo = {
  providerId: 'provider', modelId: 'model', name: 'Model', contextWindow: 64000, maxTokens: 8192,
  api: 'test', input: ['text'], reasoning: false, thinkingLevels: ['off'], thinkingLevelMap: null,
  promptCache: null, narrativeCompatible: true, supportsMidConversationSystemMessages: true,
};
const usage: ModelUsage = { inputTokens: 123, outputTokens: 55, totalTokens: 178, cacheReadTokens: 40, cacheWriteTokens: 0 };
const body = '店主递来一碗热汤。';
const stateBlock = (content: string) => '<state_update>\n' + content + '\n</state_update>';
const actions = (items: unknown = ['继续询问。', '去集市。', '离开酒馆。']) =>
  '<action_suggestions>' + JSON.stringify(items) + '</action_suggestions>';
const valid = () => body + stateBlock('{"path":"coins","value":8,"reason":"购买热汤"}') + actions();
const done = (content: string, finishReason: 'stop' | 'length' = 'stop'): ModelEvent => ({
  type: 'done', finishReason, usage, snapshot: { role: 'assistant', content, reasoning_content: '', tool_calls: [] },
});

let db: DatabaseSync, root: string, services: Services, hub: EventHub, narrative: NarrativeUsecases;
let stream: ReturnType<typeof vi.fn<ModelClient['stream']>>, seen: SessionEvent[];
beforeEach(async () => {
  db = openDatabase(':memory:');
  root = mkdtempSync(join(tmpdir(), 'sr-postprocess-'));
  services = createServices(db, root, memoryCredentials());
  const credentialRef = services.credentials.referenceFor('model');
  await services.credentials.set(credentialRef, 'test-secret');
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', name: 'World', specVersion: '0.1',
    characters: [{ id: 'player', name: 'Player', player_selectable: true }],
    openings: [{ id: 'start', name: 'Start', content: 'Opening' }],
    stateDefinition: { schema_version: 2, scopes: { message: {
      coins: { type: 'number', initial: 10, description: 'Coins', rules: { coins: 'Track spending' }, min: 0 },
      energy: { type: 'number', initial: 5, description: 'Energy', rules: { energy: 'Track energy' }, min: 0 },
      secret: { type: 'number', initial: 99, description: 'Unrelated', rules: { secret: 'Retain' }, load: { mode: 'never' } },
    } } },
  });
  services.sessions.create({ id: 'session', worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' });
  services.sessions.appendEntry('session', {
    id: 'opening', runId: 'opening-run', type: 'message', role: 'assistant',
    payload: { message: { role: 'assistant', content: 'Opening', timestamp: 1 } },
    state: [{ key: 'coins', value: 10, label: 'Currency' }, { key: 'energy', value: 5 }, { key: 'secret', value: 99 }],
  });
  hub = new EventHub(); seen = [];
  hub.subscribe('session', event => seen.push(structuredClone(event)));
  stream = vi.fn<ModelClient['stream']>(async function* () {
    yield { type: 'request_started' }; yield done(valid());
  });
  narrative = createNarrativeUsecases({ ...services, events: hub, transaction: bindTransaction(db),
    modelClient: { resolve: () => model, assertMessageOrder: vi.fn(), stream },
  });
});
afterEach(async () => {
  await narrative.shutdown();
  vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true });
});
function submit() {
  const finished = new Promise<NarrativeTerminalEvent>(resolve => {
    const stop = hub.subscribe('session', event => {
      if (event.event === 'run.completed' || event.event === 'run.stopped') {
        stop(); resolve(event as NarrativeTerminalEvent);
      }
    });
  });
  const accepted = narrative.submit({ sessionId: 'session', input: { text: '买汤' },
    expectedTipEntryId: services.sessions.require('session').tipEntryId });
  return { accepted, finished };
}
const saved = (run: AcceptedNarrative) => services.sessions.getEntry('session', run.assistantEntryId)!;
const output = (run: AcceptedNarrative) => saved(run).extData.output as unknown as NarrativeOutput;
const current = () => services.state.getCurrentMessage('session');
function script(content: string, chunks: string[] = [], finish: 'stop' | 'length' | 'missing' = 'stop') {
  stream.mockImplementation(async function* () {
    yield { type: 'request_started' };
    for (const chunk of chunks) yield { type: 'delta', delta: { content: chunk } };
    if (finish !== 'missing') yield done(content, finish);
  });
}
function visible() {
  return seen.filter(event => event.event === 'run.delta').map(event => {
    const messages = event.data.messages as { delta: { content?: string }; snapshot?: { content: string } }[];
    return messages[0]!;
  });
}

describe('narrative postprocessing integration', () => {
  it('hides split tags, commits valid JSONL rows and suggestions independently, then notifies before usage and terminal', async () => {
    const raw = body + '<STATE_UPDATE>\n{"path":"coins","value":8}\n{"broken":\n'
      + '{"path":"missing","value":1}\n{"path":"energy","value":7}\n</STATE_UPDATE>'
      + actions(['继续询问。', '', '离开酒馆。']);
    const tag = raw.indexOf('<STATE_UPDATE>');
    script(raw, [raw.slice(0, tag) + '<STA', raw.slice(tag + 4, tag + 40), raw.slice(tag + 40)]);
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(current()).toEqual({ coins: 8, energy: 7, secret: 99 });
    expect(output(accepted)).toMatchObject({
      stateUpdate: { status: 'partial_success', results: [
        { status: 'success', path: 'coins' }, { status: 'invalid_json' },
        { status: 'invalid_path', path: 'missing' }, { status: 'success', path: 'energy' },
      ] },
      actionSuggestions: { status: 'partial_success', items: ['继续询问。', '离开酒馆。'],
        results: [{ status: 'success' }, { status: 'empty_suggestion' }, { status: 'success' }] },
    });
    expect(saved(accepted).payload.message).toMatchObject({ content: body });
    expect(saved(accepted).state).toContainEqual({ key: 'coins', value: 8, label: 'Currency' });
    expect(visible().map(message => message.delta.content ?? '').join('')).toBe(body);
    expect(visible().at(-1)?.snapshot?.content).toBe(body);
    expect(JSON.stringify(visible())).not.toMatch(/state_update|action_suggestions/i);
    expect(seen.slice(-4).map(event => event.event)).toEqual([
      'state.changed', 'action_suggestions.created', 'run.usage', 'run.completed',
    ]);
    expect(seen.find(event => event.event === 'state.changed')?.data).toEqual({
      scope: 'message', path: '', value: { coins: 8, energy: 7, secret: 99 },
    });
    expect(seen.find(event => event.event === 'action_suggestions.created')?.data).toEqual({
      sessionId: 'session', runId: accepted.runId, messageId: accepted.assistantEntryId, items: ['继续询问。', '离开酒馆。'],
    });
    expect(saved(accepted).metrics?.requests[0]?.usage).toEqual(usage);
    expect(JSON.stringify(output(accepted))).not.toMatch(/blockIndex|contextEligible|"line":/);
    expect(stream).toHaveBeenCalledOnce();
  });

  it('rejects all data in an unclosed state block while independently using the intact suggestion block', async () => {
    script(body + '<state_update>\n{"path":"coins","value":1}\n' + actions());
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(output(accepted).stateUpdate).toMatchObject({ status: 'invalid_tag', updates: [], results: [] });
    expect(output(accepted).actionSuggestions.status).toBe('success');
    expect(current().coins).toBe(10);
    expect(seen.some(event => event.event === 'state.changed')).toBe(false);
    expect(seen.some(event => event.event === 'action_suggestions.created')).toBe(true);
  });

  it('uses complete state tags even when a different capability has an unclosed tag before them', async () => {
    script(body + '<action_suggestions>broken\n' + stateBlock('{"path":"coins","value":6}'));
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(output(accepted).actionSuggestions.status).toBe('invalid_tag');
    expect(output(accepted).stateUpdate.status).toBe('success');
    expect(current().coins).toBe(6);
    expect(seen.some(event => event.event === 'action_suggestions.created')).toBe(false);
  });

  it.each([
    body,
    body + '<state_update> \n </state_update><action_suggestions></action_suggestions>',
    body + '<action_suggestions>[]</action_suggestions>',
  ])('treats absent and empty blocks as normal no-op results', async raw => {
    script(raw);
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(output(accepted)).toEqual({
      stateUpdate: { status: 'no_updates', updates: [], results: [] },
      actionSuggestions: { status: 'no_suggestions', items: [], results: [] },
    });
    expect(saved(accepted).state).toBeNull();
    expect(seen.some(event => event.event === 'state.changed' || event.event === 'action_suggestions.created')).toBe(false);
  });

  it('isolates a state-material failure from suggestions and the completed narrative', async () => {
    vi.spyOn(services.state, 'prepareMessageUpdates').mockImplementation(() => { throw new Error('state read failed'); });
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(output(accepted).stateUpdate.status).toBe('processing_error');
    expect(output(accepted).actionSuggestions.status).toBe('success');
    expect(current().coins).toBe(10);
    expect(seen.some(event => event.event === 'action_suggestions.created')).toBe(true);
  });

  it('isolates a suggestion processor exception from valid state and the completed narrative', async () => {
    vi.spyOn(suggestions, 'processActionSuggestions').mockImplementation(() => { throw new Error('suggestions failed'); });
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(output(accepted).stateUpdate.status).toBe('success');
    expect(output(accepted).actionSuggestions.status).toBe('processing_error');
    expect(current().coins).toBe(8);
  });

  it('uses the authoritative final snapshot for both clean body and updates', async () => {
    const draft = body + stateBlock('{"path":"coins","value":1}') + actions(['旧建议']);
    const final = '店主退回零钱。' + stateBlock('{"path":"coins","value":9}') + actions(['新建议']);
    script(final, [draft]);
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(current().coins).toBe(9);
    expect(saved(accepted).payload.message).toMatchObject({ content: '店主退回零钱。' });
    expect(output(accepted).actionSuggestions.items).toEqual(['新建议']);
    expect(JSON.stringify(visible())).not.toContain('旧建议');
  });

  it.each(['length', 'missing'] as const)('does not execute complete data blocks when model completion is %s', async finish => {
    const raw = valid(); script(raw, [raw], finish);
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'output_incomplete' } });
    expect(saved(accepted).payload.message).toMatchObject({ content: body });
    expect(saved(accepted).extData).not.toHaveProperty('output');
    expect(current().coins).toBe(10);
    expect(seen.some(event => event.event === 'state.changed' || event.event === 'action_suggestions.created')).toBe(false);
  });

  it('cancels after final snapshot without executing capabilities and preserves only clean partial content', async () => {
    hub.subscribe('session', event => {
      if (event.event === 'run.delta' && (event.data.messages as { snapshot?: unknown }[])[0]?.snapshot) {
        narrative.stop('session', event.data.runId as string);
      }
    });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'cancelled' } });
    expect(saved(accepted).payload.message).toMatchObject({ content: body });
    expect(saved(accepted).extData).not.toHaveProperty('output');
    expect(current().coins).toBe(10);
  });

  it('does not create an assistant or execute capabilities when only hidden blocks were produced', async () => {
    script(stateBlock('{"path":"coins","value":1}') + actions());
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'model_output_invalid' } });
    expect(services.sessions.getEntry('session', accepted.assistantEntryId)).toBeNull();
    expect(current().coins).toBe(10);
  });

  it('rolls back an assistant/state append failure and emits no uncommitted capability notifications', async () => {
    const append = services.sessions.appendNarrativeAssistant.bind(services.sessions);
    vi.spyOn(services.sessions, 'appendNarrativeAssistant').mockImplementation((...args) => {
      append(...args); throw new Error('failure after append');
    });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: {
      stop_reason: 'message_persist_failed', savedMessageIds: [accepted.userEntryId], tipEntryId: accepted.userEntryId,
    } });
    expect(services.sessions.getEntry('session', accepted.assistantEntryId)).toBeNull();
    expect(current().coins).toBe(10);
    expect(seen.some(event => event.event === 'state.changed' || event.event === 'action_suggestions.created')).toBe(false);
  });

  it('notifies committed state but withholds suggestions if recording the run outcome fails', async () => {
    vi.spyOn(services.sessions, 'setNarrativeOutcome').mockImplementation(() => { throw new Error('outcome failed'); });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'message_persist_failed' } });
    expect(current().coins).toBe(8);
    expect(saved(accepted).extData).toHaveProperty('output');
    expect(seen.some(event => event.event === 'state.changed')).toBe(true);
    expect(seen.some(event => event.event === 'action_suggestions.created')).toBe(false);
  });

  it('continues later notifications and settlement if publishing one capability notification throws', async () => {
    const publish = hub.publish.bind(hub);
    vi.spyOn(hub, 'publish').mockImplementation((sessionId, event) => {
      if (event.event === 'state.changed') throw new Error('delivery failed');
      publish(sessionId, event);
    });
    expect((await submit().finished).event).toBe('run.completed');
    expect(seen.slice(-3).map(event => event.event)).toEqual(['action_suggestions.created', 'run.usage', 'run.completed']);
    expect(current().coins).toBe(8);
  });

  it('keeps historical assistant messages clean without model-only notes or replaying updates', async () => {
    const first = submit(); await first.finished;
    script(body);
    const second = submit(); await second.finished;
    const history = stream.mock.calls[1]![1].filter(message => message.role === 'assistant');
    expect(history.map(message => message.content)).toEqual(['Opening', body]);
    expect(JSON.stringify(history)).not.toMatch(/state_update|action_suggestions/);
    expect(output(second.accepted).stateUpdate.status).toBe('no_updates');
    expect(current().coins).toBe(8);
  });

  it('does not impose a separate 100-row output quota', async () => {
    const rows = Array.from({ length: 105 }, (_, value) => JSON.stringify({ path: 'coins', value })).join('\n');
    script(body + stateBlock(rows));
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(output(accepted).stateUpdate.results).toHaveLength(105);
    expect(output(accepted).stateUpdate.status).toBe('success');
    expect(current().coins).toBe(104);
  });
});
