import { worldPublication } from '../../testing/fixtures.js';
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
import { processNarrativeOutput } from './postprocess/processor.js';

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
let logLines: string[];
let stream: ReturnType<typeof vi.fn<ModelClient['stream']>>, seen: SessionEvent[];
beforeEach(async () => {
  logLines = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { logLines.push(line); });
  db = openDatabase(':memory:');
  root = mkdtempSync(join(tmpdir(), 'sr-postprocess-'));
  services = createServices(db, root, memoryCredentials());
  const credentialRef = services.credentials.referenceFor('model');
  await services.credentials.set(credentialRef, 'test-secret');
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', name: 'World', specVersion: '0.2', publication: worldPublication(),
    characters: [{ id: 'player', name: 'Player', player_selectable: true }],
    openings: [{ id: 'start', name: 'Start', content: 'Opening' }],
    stateDefinition: { schema_version: 2, scopes: { message: {
      coins: { type: 'number', initial: 10, description: 'Coins', rules: { coins: 'Track spending' }, min: 0 },
      energy: { type: 'number', initial: 5, description: 'Energy', rules: { energy: 'Track energy' }, min: 0 },
      secret: { type: 'number', initial: 99, description: 'Unrelated', rules: { secret: 'Retain' }, load: { mode: 'never' } },
    } } },
  });
  services.sessions.create({ id: 'session', worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player' });
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
function submit(text = '买汤') {
  const finished = new Promise<NarrativeTerminalEvent>(resolve => {
    const stop = hub.subscribe('session', event => {
      if (event.event === 'run.completed' || event.event === 'run.stopped') {
        stop(); resolve(event as NarrativeTerminalEvent);
      }
    });
  });
  const accepted = narrative.submit({ sessionId: 'session', input: { text },
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
      stateUpdate: { status: 'partial_success', updates: [
        { status: 'success', path: 'coins', value: 8 }, { status: 'invalid_json' },
        { status: 'invalid_path', path: 'missing', value: 1 }, { status: 'success', path: 'energy', value: 7 },
      ] },
      actionSuggestions: { status: 'partial_success', items: ['继续询问。', '离开酒馆。'] },
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
    expect(JSON.stringify(output(accepted))).not.toMatch(/blockIndex|contextEligible|"line":|"results":/);
    expect(stream).toHaveBeenCalledOnce();
  });

  it.each([
    ['__proto__', '{"__proto__":{"polluted":true}}'],
    ['constructor', '{"constructor":{"prototype":{"polluted":true}}}'],
    ['prototype', '{"prototype":{"polluted":true}}'],
    ['nested unsafe keys', '{"nested":[{"constructor":{"prototype":{"polluted":true}}},{"__proto__":{"polluted":true}}]}'],
  ])('isolates %s in a rejected value through output persistence and completion', async (_name, value) => {
    const rejected = '{"path":"energy","value":' + value + ',"reason":"Rejected payload"}';
    const rows = '{"path":"coins","value":8}\n' + rejected + '\n{"path":"coins","value":9}';
    script(body + stateBlock(rows) + actions());
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.completed' });
    expect(current()).toEqual({ coins: 9, energy: 5, secret: 99 });
    expect(output(accepted)).toMatchObject({
      stateUpdate: { status: 'partial_success', updates: [
        { status: 'success', path: 'coins', value: 8 },
        { status: 'invalid_value', path: 'energy', reason: 'Rejected payload', errorCode: 'INVALID_STATE_KEY' },
        { status: 'success', path: 'coins', value: 9 },
      ] },
      actionSuggestions: { status: 'success', items: ['继续询问。', '去集市。', '离开酒馆。'] },
    });
    const rejectedOutput = output(accepted).stateUpdate.updates[1]!;
    if (value.includes('"__proto__"')) expect(rejectedOutput).not.toHaveProperty('value');
    else expect(rejectedOutput.value).toEqual(JSON.parse(value));
    expect(saved(accepted).payload.message).toMatchObject({ content: body });
    expect(seen.slice(-4).map(event => event.event)).toEqual([
      'state.changed', 'action_suggestions.created', 'run.usage', 'run.completed',
    ]);
    expect(capabilityLog('state_update.raw')).toMatchObject({ blocks: ['\n' + rows + '\n'] });
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('rejects all data in an unclosed state block while independently using the intact suggestion block', async () => {
    script(body + '<state_update>\n{"path":"coins","value":1}\n' + actions());
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(output(accepted).stateUpdate).toMatchObject({ status: 'invalid_tag', updates: [] });
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
      stateUpdate: { status: 'no_updates', updates: [] },
      actionSuggestions: { status: 'no_suggestions', items: [] },
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
    expect(await finished).toMatchObject({ event: 'run.stopped', data: {
      stop_reason: finish === 'length' ? 'output_limit_reached' : 'output_incomplete',
    } });
    expect(saved(accepted).payload.message).toMatchObject({ content: body });
    expect(saved(accepted).extData).not.toHaveProperty('output');
    expect(current().coins).toBe(10);
    expect(seen.some(event => event.event === 'state.changed' || event.event === 'action_suggestions.created')).toBe(false);
  });

  it('cancels after final snapshot without executing capabilities and preserves only clean partial content', async () => {
    hub.subscribe('session', event => {
      if (event.event === 'run.delta' && (event.data.messages as { snapshot?: unknown }[])[0]?.snapshot) {
        narrative.stop('session', event.data.runId as string, event.data.assistantEntryId as string);
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

  it.each(['enabled', 'disabled', 'absent'] as const)('carries scene facts across turns with state updates %s', async mode => {
    const scene = { 当前日期: '新历2088年01月01日', 当前时刻: '23:00', 当日时段: '侍寝时段', 当前地点: '走廊' };
    services.worlds.update('world', { stateDefinition: { schema_version: 2, scopes: { message: {
      世界: { type: 'json', initial: scene, description: '场景时间与地点', rules: { '世界.当前时刻': '按经过的时长推进。' } },
    } } } });
    services.sessions.setEntryState('session', 'opening', [{ key: '世界', value: scene }]);
    const config = services.presets.getDefault().config;
    services.presets.update('preset', { config });
    const arrival = { path: '世界.当前地点', value: 'Robin主卧', reason: '抵达主卧' };
    script('阿柳走进主卧。' + stateBlock(JSON.stringify(arrival)));
    expect((await submit('走进主卧').finished).event).toBe('run.completed');

    const enabled = mode === 'enabled';
    if (mode === 'absent') config.nodes = config.nodes.filter(node => node.id !== 'stateUpdate');
    else config.nodes.find(node => node.id === 'stateUpdate')!.enabled = enabled;
    services.presets.update('preset', { config });
    seen = [];
    const tick = { path: '世界.当前时刻', value: '23:15', reason: '等待十五分钟' };
    const story = '墙上的钟走过十五分钟。';
    script(story + stateBlock(JSON.stringify(tick)));
    const turn = submit('我坐在原处等了十五分钟');
    expect((await turn.finished).event).toBe('run.completed');
    const messages = stream.mock.calls[1]![1];
    const facts = messages.find(message => message.content.startsWith('这些是当前会话'))!.content;
    expect(facts).toContain(JSON.stringify({ ...scene, 当前地点: 'Robin主卧' }));
    expect(facts).toContain('type: json');
    expect(facts).not.toContain('rules:');
    const instructions = messages.at(-1)!.content;
    expect(instructions.includes('世界.当前时刻: 按经过的时长推进。')).toBe(enabled);
    expect(instructions.includes('state_update 使用 JSONL')).toBe(enabled);
    const arrivalHistory = messages.find(message => message.content.startsWith('阿柳走进主卧。'))!;
    expect(arrivalHistory.content.includes(stateBlock(JSON.stringify(arrival)))).toBe(enabled);
    const finalScene = { ...scene, 当前地点: 'Robin主卧', 当前时刻: enabled ? '23:15' : '23:00' };
    expect(current()).toEqual({ 世界: finalScene });
    expect(seen.some(event => event.event === 'state.changed')).toBe(enabled);
    expect(output(turn.accepted).stateUpdate).toMatchObject(enabled
      ? { status: 'success', updates: [{ status: 'success', ...tick }] }
      : { status: 'invalid_updates', updates: [{ status: 'invalid_path', errorCode: 'STATE_ROOT_NOT_ACTIVE' }] });
    expect(saved(turn.accepted).payload.message).toMatchObject({ content: story });

    script('她看了一眼钟。');
    expect((await submit('看看几点了').finished).event).toBe('run.completed');
    const next = stream.mock.calls[2]![1];
    expect(next.find(message => message.content.startsWith('这些是当前会话'))!.content).toContain(JSON.stringify(finalScene));
    expect(next.find(message => message.content.startsWith(story))!.content.includes(stateBlock(JSON.stringify(tick)))).toBe(enabled);
  });

  it('adds historical notes only to the next model request without changing stored prose or replaying updates', async () => {
    const prepareUpdates = vi.spyOn(services.state, 'prepareMessageUpdates');
    const first = submit(); await first.finished;
    const firstSaved = structuredClone(saved(first.accepted));
    seen = [];
    script(body);
    const second = submit(); await second.finished;
    const history = stream.mock.calls[1]![1].filter(message => message.role === 'assistant');
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe(['Opening', '', '<state_update>', '</state_update>', actions([])].join('\n'));
    expect(history[1]!.content).toBe([
      body, '', stateBlock('{"path":"coins","value":8,"reason":"购买热汤"}'), actions(),
    ].join('\n'));
    expect(saved(first.accepted)).toEqual(firstSaved);
    const storedMessages = services.sessions.getHistory('session')
      .filter(entry => entry.type === 'message' && entry.role === 'assistant').map(entry => entry.payload.message);
    expect(storedMessages).toEqual([
      expect.objectContaining({ content: 'Opening' }),
      expect.objectContaining({ content: body }),
      expect.objectContaining({ content: body }),
    ]);
    expect(JSON.stringify(storedMessages)).not.toMatch(/model_notes|state_update|action_suggestions/);
    expect(JSON.stringify(visible())).not.toMatch(/model_notes|state_update|action_suggestions/);
    expect(output(second.accepted)).toMatchObject({
      stateUpdate: { status: 'no_updates' }, actionSuggestions: { status: 'no_suggestions' },
    });
    expect(prepareUpdates).toHaveBeenCalledOnce();
    expect(seen.some(event => event.event === 'state.changed' || event.event === 'action_suggestions.created')).toBe(false);
    expect(current().coins).toBe(8);
  });

  it('does not impose a separate 100-row output quota', async () => {
    const rows = Array.from({ length: 105 }, (_, value) => JSON.stringify({ path: 'coins', value })).join('\n');
    script(body + stateBlock(rows));
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(output(accepted).stateUpdate.updates).toHaveLength(105);
    expect(output(accepted).stateUpdate.status).toBe('success');
    expect(current().coins).toBe(104);
  });
});


function capabilityLog(event: string) {
  const line = logLines.find(line => line.includes('] [' + event + '] ['));
  if (!line) throw new Error('Missing log: ' + event);
  return JSON.parse(line.slice(line.indexOf('] [', line.indexOf('] [') + 1) + 3, -1)) as Record<string, unknown>;
}

describe('postprocess diagnostics', () => {
  it('isolates rejected async diagnostic observers from both capability results', async () => {
    const processed = processNarrativeOutput(valid(), services.state, {
      sessionId: 'session', parentId: services.sessions.require('session').tipEntryId!, allowedRoots: ['coins', 'energy'],
    }, async () => { throw new Error('async observer failed'); });
    await Promise.resolve();
    expect(processed.output.stateUpdate.status).toBe('success');
    expect(processed.output.actionSuggestions.status).toBe('success');
    expect(current().coins).toBe(10);
  });

  it('preserves raw JSONL and records compact state rows and suggestion outcome before persistence', async () => {
    const rawUpdates = '\n{"path":"coins","value":8}\n{"broken":\n{"path":"energy","value":7}\n';
    script(body + '<STATE_UPDATE>' + rawUpdates + '</STATE_UPDATE>' + actions(['继续询问。', '', 17]));
    expect((await submit().finished).event).toBe('run.completed');
    expect(capabilityLog('state_update.raw')).toMatchObject({ tagStatus: 'present',
      source: 'block_contents', blocks: [rawUpdates] });
    expect(capabilityLog('state_update.result')).toMatchObject({
      phase: 'prepared', status: 'partial_success',
      updates: [{ status: 'success' }, { status: 'invalid_json' }, { status: 'success' }],
    });
    expect(capabilityLog('action_suggestions.raw')).toMatchObject({ blocks: ['["继续询问。","",17]'] });
    expect(capabilityLog('action_suggestions.result')).toMatchObject({
      phase: 'prepared', status: 'partial_success',
      items: ['继续询问。'],
    });
    expect(capabilityLog('action_suggestions.result')).not.toHaveProperty('results');
    expect(capabilityLog('state_update.result')).not.toHaveProperty('results');
    expect(capabilityLog('postprocess.completed')).toMatchObject({ persisted: true, stateChanged: true });
  });

  it('retains the source of a broken own tag while independently reporting the intact capability', async () => {
    const raw = body + '<state_update>{"path":"coins","value":1}\n' + actions();
    script(raw);
    expect((await submit().finished).event).toBe('run.completed');
    expect(capabilityLog('state_update.raw')).toMatchObject({
      tagStatus: 'invalid_tag', source: 'unparsed_model_output', raw, blocks: [],
    });
    expect(capabilityLog('state_update.result')).toMatchObject({ status: 'invalid_tag' });
    expect(capabilityLog('action_suggestions.result')).toMatchObject({ status: 'success' });
    expect(current().coins).toBe(10);
  });

  it('does not claim postprocess persistence when the assistant transaction rolls back', async () => {
    vi.spyOn(services.sessions, 'appendNarrativeAssistant').mockImplementation(() => { throw new Error('storage failed'); });
    expect((await submit().finished).event).toBe('run.stopped');
    expect(capabilityLog('state_update.result')).toMatchObject({ phase: 'prepared', status: 'success' });
    expect(logLines.some(line => line.includes('[postprocess.completed]'))).toBe(false);
    expect(capabilityLog('message.persist_failed')).toMatchObject({ persisted: false, stop_reason: 'message_persist_failed' });
    expect(current().coins).toBe(10);
    expect(seen.some(event => event.event === 'state.changed')).toBe(false);
  });
});
