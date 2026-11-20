import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors.js';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { bindTransaction } from '../../infrastructure/database/transaction.js';
import { EventHub } from '../../infrastructure/events/event-hub.js';
import type {
  ModelClient, ModelEvent, ModelInfo, ModelSnapshot, ModelStopReason, ModelUsage,
} from '../../infrastructure/model/client.js';
import { createServices, type Services } from '../../services.js';
import { memoryCredentials } from '../../testing/credentials.js';
import { narrativePreset } from '../../testing/fixtures.js';
import type { NarrativeEvent, NarrativeTerminalEvent } from './events.js';
import { createNarrativeUsecases, type NarrativeUsecases, type SubmitInput } from './index.js';

const model: ModelInfo = {
  modelId: 'story-model', name: 'Story model', providerId: 'test-provider', api: 'openai-completions',
  reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 8192,
  thinkingLevels: ['off'], thinkingLevelMap: null, promptCache: null,
  narrativeCompatible: true, supportsMidConversationSystemMessages: false,
};
const usage: ModelUsage = { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 0 };
const zeroUsage: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const wireUsage = (value: ModelUsage | null) => value === null ? null : ({
  input_tokens: value.inputTokens, output_tokens: value.outputTokens, total_tokens: value.totalTokens,
  cache_read_tokens: value.cacheReadTokens, cache_write_tokens: value.cacheWriteTokens,
});
const snapshot = (content = '', extra: Partial<ModelSnapshot> = {}): ModelSnapshot => ({
  role: 'assistant', content, reasoning_content: '', tool_calls: [], ...extra,
});
const done = (content = '完整正文', extra: Partial<Extract<ModelEvent, { type: 'done' }>> = {}): ModelEvent => ({
  type: 'done', snapshot: snapshot(content), finishReason: 'stop', usage, ...extra,
});
const failure = (stopReason: ModelStopReason, content = '', extra: Partial<Extract<ModelEvent, { type: 'error' }>> = {}): ModelEvent => ({
  type: 'error', snapshot: snapshot(content), stopReason, usage, ...extra,
});
const text = (content: string): ModelEvent => ({ type: 'delta', delta: { content } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

let db: DatabaseSync, services: Services, dataRoot: string;
let logLines: string[];
let events: EventHub, narrative: NarrativeUsecases, seen: NarrativeEvent[];
let stream: ReturnType<typeof vi.fn<ModelClient['stream']>>;
let resolveModel: ReturnType<typeof vi.fn<ModelClient['resolve']>>;

beforeEach(async () => {
  logLines = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { logLines.push(line); });
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-narrative-run-'));
  services = createServices(db, dataRoot, memoryCredentials());
  const credentialRef = services.credentials.referenceFor('model');
  await services.credentials.set(credentialRef, 'private-test-secret');
  services.models.create({ id: 'model', name: 'Model', providerId: model.providerId, modelId: model.modelId, credentialRef });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', name: 'World', specVersion: '0.1', state: { day: 1 },
    characters: [{ id: 'player', name: 'Player', player_selectable: true }],
    openings: [{ id: 'start', name: 'Start', content: 'An unused opening' }],
  });
  createSession('session');
  events = new EventHub();
  seen = [];
  events.subscribe('session', event => seen.push(structuredClone(event) as NarrativeEvent));
  stream = vi.fn<ModelClient['stream']>(async function* () {
    yield { type: 'request_started' };
    yield text('完整');
    yield text('正文');
    yield done();
  });
  resolveModel = vi.fn<ModelClient['resolve']>(() => model);
  narrative = createNarrativeUsecases({
    ...services, events, transaction: bindTransaction(db), modelClient: { resolve: resolveModel, assertMessageOrder: vi.fn(), stream },
  });
});

afterEach(async () => {
  await narrative.shutdown();
  for (const runId of new Set(seen.map(event => event.data.runId))) assertLifecycle(runId);
  vi.restoreAllMocks();
  db.close();
  rmSync(dataRoot, { recursive: true, force: true });
});

function createSession(id: string) {
  return services.sessions.create({
    id, worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player',
    state: { coins: 2 },
  });
}
function terminal(sessionId = 'session') {
  return new Promise<NarrativeTerminalEvent>(resolve => {
    const unsubscribe = events.subscribe(sessionId, event => {
      if (event.event === 'run.completed' || event.event === 'run.stopped') {
        unsubscribe();
        resolve(event as NarrativeTerminalEvent);
      }
    });
  });
}
function submit(content = '玩家输入', sessionId = 'session') {
  const finished = terminal(sessionId);
  const accepted = narrative.submit({
    sessionId, input: { text: content }, expectedTipEntryId: services.sessions.require(sessionId).tipEntryId,
  });
  return { accepted, finished };
}
function history(sessionId = 'session') { return services.sessions.getHistory(sessionId); }
function texts(sessionId = 'session') { return history(sessionId).map(entry => (entry.payload.message as { content: string }).content); }
function script(items: ModelEvent[]) {
  stream.mockImplementation(async function* () {
    yield { type: 'request_started' };
    for (const item of items) yield item;
  });
}
function deltas(runId?: string) {
  return seen.filter((event): event is Extract<NarrativeEvent, { event: 'run.delta' }> =>
    event.event === 'run.delta' && (runId === undefined || event.data.runId === runId));
}
function finalMessage(runId?: string) { return deltas(runId).at(-1)?.data.messages[0]; }
function runUsage(runId: string) {
  return seen.find((event): event is Extract<NarrativeEvent, { event: 'run.usage' }> =>
    event.event === 'run.usage' && event.data.runId === runId)!.data.usage;
}
function allKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...allKeys(item)]);
}
function assertLifecycle(runId: string) {
  const own = seen.filter(event => event.data.runId === runId);
  expect(own[0]?.event).toBe('run.created');
  expect(own.filter(event => event.event === 'run.usage')).toHaveLength(1);
  expect(own.filter(event => event.event === 'run.completed' || event.event === 'run.stopped')).toHaveLength(1);
  expect(own.at(-2)?.event).toBe('run.usage');
  expect(['run.completed', 'run.stopped']).toContain(own.at(-1)?.event);
  for (const event of own) {
    expect(event.data).toMatchObject({ runId, sessionId: 'session', timestamp: expect.any(Number) });
    expect(allKeys(event)).not.toContain('error');
    expect(allKeys(event)).not.toContain('errorCode');
    expect(allKeys(event)).not.toContain('errorMessage');
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    if (event.event === 'run.usage') {
      expect(Object.keys(event.data).sort()).toEqual(['model', 'provider', 'runId', 'sessionId', 'timestamp', 'usage']);
      if (event.data.usage !== null) expect(Object.keys(event.data.usage).sort()).toEqual([
        'cache_read_tokens', 'cache_write_tokens', 'input_tokens', 'output_tokens', 'total_tokens',
      ]);
    } else if (event.event === 'run.created') {
      expect(event.data.messages).toHaveLength(1);
      expect(Object.keys(event.data.messages[0]).sort()).toEqual(['content', 'id', 'role', 'timestamp']);
    } else if (event.event === 'run.delta') {
      expect(event.data.messageId).toEqual(expect.any(String));
      expect(event.data.messages).toHaveLength(1);
      expect(event.data.messages[0].role).toBe('assistant');
    } else if (event.event === 'run.stopped') {
      expect(Object.keys(event.data).sort()).toEqual([
        'model', 'provider', 'runId', 'savedMessageIds', 'sessionId', 'stop_reason', 'timestamp', 'tipEntryId',
      ]);
    }
  }
  expect(JSON.stringify(own)).not.toContain('private-test-secret');
}

describe('unified narrative events and independent persistence', () => {
  it('saves the user before model work, then publishes one usage total and the committed assistant result', async () => {
    const observedPersisted: string[] = [];
    events.subscribe('session', event => {
      if (event.event === 'run.created') observedPersisted.push(...services.sessions.listEntryRuns('session').items.find(item => item.runId === event.data.runId)!.entries.map(entry => entry.id));
      if (event.event === 'run.usage') observedPersisted.push(services.sessions.require('session').tipEntryId!);
    });
    const { accepted, finished } = submit();
    expect(stream).not.toHaveBeenCalled();
    expect(resolveModel).not.toHaveBeenCalled();
    expect(texts()).toEqual(['玩家输入']);
    expect(history()[0]).toMatchObject({ id: accepted.userEntryId, runId: accepted.runId, state: null, extData: {}, metrics: null });
    expect(accepted).not.toHaveProperty('capabilities');
    expect(await finished).toMatchObject({ event: 'run.completed', data: {
      runId: accepted.runId, provider: model.providerId, model: model.modelId,
      savedMessageIds: [accepted.userEntryId, accepted.assistantEntryId], tipEntryId: accepted.assistantEntryId,
    } });
    expect(observedPersisted).toEqual([accepted.userEntryId, accepted.assistantEntryId]);
    expect(seen[0]).toMatchObject({ event: 'run.created', data: { messages: [{
      id: accepted.userEntryId, role: 'user', content: '玩家输入', timestamp: history()[0]!.timestamp,
    }] } });
    expect(texts()).toEqual(['玩家输入', '完整正文']);
    expect(history()[1]).toMatchObject({
      parentId: accepted.userEntryId, state: null, extData: { output: {
        stateUpdate: { status: 'no_updates', updates: [] },
        actionSuggestions: { status: 'no_suggestions', items: [] },
      } },
      payload: { message: snapshot('完整正文') },
      metrics: { requests: [{ provider: model.providerId, modelId: 'story-model', usage }] },
    });
    expect(history()[1]!.metrics!.requests[0]!.requestId).not.toBe(accepted.runId);
    expect(seen.map(event => event.event)).toEqual(['run.created', 'run.delta', 'run.delta', 'run.delta', 'run.usage', 'run.completed']);
    expect(deltas().slice(0, -1).map(event => event.data.messages[0].delta.content)).toEqual(['完整', '正文']);
    expect(finalMessage()).toEqual({ role: 'assistant', delta: {}, snapshot: snapshot('完整正文'), finish_reason: 'stop' });
    expect(runUsage(accepted.runId)).toEqual(wireUsage(usage));
    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]![1].slice(0, -1).map(message => message.content)).toEqual(['玩家输入']);
    expect(services.state.getGlobal('world')).toEqual({ day: 1 });
    expect(services.state.getSession('session')).toEqual({ coins: 2 });
  });

  it('timestamps usage before the terminal result in publication order', async () => {
    let tick = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => tick++);
    await submit().finished;
    const timestamps = seen.map(event => event.data.timestamp);
    expect(timestamps).toEqual([...timestamps].sort((left, right) => left - right));
  });

  it('treats the final SDK snapshot as a replacement, including corrections and removed tools', async () => {
    script([
      { type: 'delta', delta: { content: '错误草稿', reasoning_content: '初步思考', tool_calls: [{ index: 0, id: 'draft', function: { name: 'draft', arguments: '{' } }] } },
      done('校正正文', { snapshot: snapshot('校正正文', { reasoning_content: '校正思考' }) }),
    ]);
    const { finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(finalMessage()).toMatchObject({ snapshot: snapshot('校正正文', { reasoning_content: '校正思考' }) });
    expect(history()[1]!.payload.message).toMatchObject(snapshot('校正正文', { reasoning_content: '校正思考' }));
    expect(JSON.stringify(history()[1]!.payload)).not.toContain('draft');
  });

  it.each([
    { name: 'provider failure', events: [text('半段'), failure('provider_error', '半段后续')], body: '半段后续', reason: 'provider_error', knownUsage: usage },
    { name: 'missing terminal', events: [text('半段')], body: '半段', reason: 'output_incomplete', knownUsage: null },
    { name: 'length limit', events: [text('半段'), done('半段后续', { finishReason: 'length' })], body: '半段后续', reason: 'output_incomplete', knownUsage: usage },
    { name: 'deferred completion', events: [done('待续', { finishReason: 'deferred' })], body: '待续', reason: 'output_incomplete', knownUsage: usage },
    { name: 'provider abort', events: [failure('aborted', '已收到')], body: '已收到', reason: 'provider_aborted', knownUsage: usage },
    { name: 'provider context overflow', events: [failure('context_window_exceeded', '部分', { usage: null })], body: '部分', reason: 'provider_context_window_exceeded', knownUsage: null },
    { name: 'invalid model result', events: [failure('invalid_output', '可保存部分')], body: '可保存部分', reason: 'model_output_invalid', knownUsage: usage },
    { name: 'incomplete model result', events: [failure('incomplete_output', '可保存部分')], body: '可保存部分', reason: 'output_incomplete', knownUsage: usage },
  ])('persists partial output after $name and exposes only stop_reason', async ({ events: items, body, reason, knownUsage }) => {
    script(items);
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: {
      stop_reason: reason, savedMessageIds: [accepted.userEntryId, accepted.assistantEntryId], tipEntryId: accepted.assistantEntryId,
    } });
    expect(texts()).toEqual(['玩家输入', body]);
    expect(history()[1]!.metrics!.requests[0]).not.toHaveProperty('status');
    expect(history()[0]!.extData.narrative).toMatchObject({ status: 'stopped', stopReason: reason });
    expect(finalMessage()?.snapshot?.content).toBe(body);
    expect(runUsage(accepted.runId)).toEqual(wireUsage(knownUsage));
  });

  it('keeps public reasoning without making it an empty history turn or a successful visible answer', async () => {
    script([done('', { snapshot: snapshot('', { reasoning_content: '已公开的思考' }) })]);
    const first = submit('第一轮');
    expect(await first.finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'model_output_invalid' } });
    expect(history()[1]!.payload.message).toMatchObject(snapshot('', { reasoning_content: '已公开的思考' }));
    script([done('下一轮正文')]);
    expect((await submit('下一轮').finished).event).toBe('run.completed');
    expect(stream.mock.calls[1]![1].slice(0, -1).map(message => [message.role, message.content])).toEqual([['user', '第一轮'], ['user', '下一轮']]);
  });

  it('streams and saves tool requests, but ends without running a tool or issuing another model request', async () => {
    const tool = { index: 0, id: 'call-1', type: 'function' as const, function: { name: 'search', arguments: '{"q":"river"}' } };
    script([
      { type: 'delta', delta: { tool_calls: [{ index: 0 }] } },
      { type: 'delta', delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'search', arguments: '{"q":' } }] } },
      { type: 'delta', delta: { tool_calls: [{ index: 0, function: { arguments: '"river"}' } }] } },
      done('', { snapshot: snapshot('', { tool_calls: [tool] }), finishReason: 'tool_calls' }),
    ]);
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'tool_execution_unsupported' } });
    expect(history()[1]!.payload.message).toMatchObject(snapshot('', { tool_calls: [tool] }));
    expect(finalMessage()).toMatchObject({ finish_reason: 'tool_calls', snapshot: snapshot('', { tool_calls: [tool] }) });
    expect(stream).toHaveBeenCalledOnce();
    expect(runUsage(accepted.runId)).toEqual(wireUsage(usage));
  });

  it('retains an unfinished tool fragment without inventing a successful tool call', async () => {
    script([{ type: 'delta', delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }]);
    expect(await submit().finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'output_incomplete' } });
    expect(history()[1]!.payload.message).toMatchObject(snapshot('', {
      tool_calls: [{ index: 0, id: '', type: 'function', function: { name: '', arguments: '{' } }],
    }));
    expect(finalMessage()).not.toHaveProperty('finish_reason');
  });

  it('does not let a finished tool request masquerade as a normal completed answer', async () => {
    script([done('说明', { snapshot: snapshot('说明', { tool_calls: [
      { index: 0, id: 'call', type: 'function', function: { name: 'search', arguments: '{}' } },
    ] }) })]);
    expect(await submit().finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'tool_execution_unsupported' } });
    expect(finalMessage()?.finish_reason).toBe('stop');
  });

  it.each([
    { name: 'empty provider failure', events: [failure('provider_error', '', { usage: null })], reason: 'provider_error', expectedUsage: null },
    { name: 'empty final answer', events: [done('')], reason: 'model_output_invalid', expectedUsage: usage },
    { name: 'whitespace only', events: [done('  \n ')], reason: 'model_output_invalid', expectedUsage: usage },
    { name: 'no terminal or content', events: [], reason: 'output_incomplete', expectedUsage: null },
    { name: 'authoritative empty replacement', events: [text('被替换的草稿'), done('')], reason: 'model_output_invalid', expectedUsage: usage },
  ])('does not create an empty assistant after $name', async ({ events: items, reason, expectedUsage }) => {
    script(items);
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: {
      stop_reason: reason, savedMessageIds: [accepted.userEntryId], tipEntryId: accepted.userEntryId,
    } });
    expect(texts()).toEqual(['玩家输入']);
    expect(runUsage(accepted.runId)).toEqual(wireUsage(expectedUsage));
    expect(history()[0]!.metrics).toBeNull();
  });

  it('continues from saved partial visible history and supports a body returned only in the final snapshot', async () => {
    script([failure('provider_error', '之前的半截故事', { usage: null })]);
    await submit('上一轮输入').finished;
    script([done('继续后的完整故事')]);
    const { accepted, finished } = submit('继续');
    expect(await finished).toMatchObject({ event: 'run.completed', data: { tipEntryId: accepted.assistantEntryId } });
    expect(stream.mock.calls[1]![1].slice(0, -1).map(message => [message.role, message.content])).toEqual([
      ['user', '上一轮输入'], ['assistant', '之前的半截故事'], ['user', '继续'],
    ]);
  });

  it('hides raw iterator failures and reports unknown usage for an attempted request', async () => {
    stream.mockImplementation(async function* () {
      yield { type: 'request_started' };
      yield text('已生成');
      throw new Error('key=private-test-secret, path=/private/model');
    });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'provider_error' } });
    expect(texts()).toEqual(['玩家输入', '已生成']);
    expect(runUsage(accepted.runId)).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('/private/model');
  });
});

describe('pre-request and persistence failures', () => {
  it.each([
    ['MODEL_NOT_FOUND', 'model_not_found'],
    ['MODEL_CAPABILITY_UNSUPPORTED', 'model_capability_unsupported'],
    ['CONTEXT_BUDGET_EXCEEDED', 'context_budget_exceeded'],
  ] as const)('persists the user and emits true zero usage for %s before invocation', async (code, reason) => {
    resolveModel.mockImplementationOnce(() => { throw new AppError(code); });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: {
      stop_reason: reason, savedMessageIds: [accepted.userEntryId], tipEntryId: accepted.userEntryId,
    } });
    expect(runUsage(accepted.runId)).toEqual(wireUsage(zeroUsage));
    expect(stream).not.toHaveBeenCalled();
    expect(deltas()).toEqual([]);
  });

  it.each([
    { kind: 'missing', reason: 'credential_not_configured' },
    { kind: 'unavailable', reason: 'credential_unavailable' },
  ])('keeps the user when credentials are $kind, without a model request', async ({ kind, reason }) => {
    const get = vi.spyOn(services.credentials, 'get');
    if (kind === 'missing') get.mockResolvedValueOnce(null);
    else get.mockRejectedValueOnce(new AppError('CREDENTIAL_STORE_ERROR', 'private-test-secret'));
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: reason } });
    expect(runUsage(accepted.runId)).toEqual(wireUsage(zeroUsage));
    expect(stream).not.toHaveBeenCalled();
  });

  it('retains saved users on unsupported context and preserves provider/model metadata where known', async () => {
    services.sessions.appendEntry('session', { id: 'bad', runId: 'old', type: 'message', role: 'assistant', payload: { message: { role: 'user', content: 'Wrong role', timestamp: 100 } } });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'invalid_context' } });
    expect(seen[0]).toMatchObject({ event: 'run.created', data: { provider: model.providerId, model: model.modelId } });
    expect(history().at(-1)?.id).toBe(accepted.userEntryId);
    expect(runUsage(accepted.runId)).toEqual(wireUsage(zeroUsage));
    expect(stream).not.toHaveBeenCalled();
  });

  it('uses null metadata when the configured model cannot be read', async () => {
    vi.spyOn(services.models, 'get').mockReturnValue(null);
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { provider: null, model: null, stop_reason: 'invalid_context' } });
    expect(seen[0]).toMatchObject({ event: 'run.created', data: { provider: null, model: null } });
    expect(runUsage(accepted.runId)).toEqual(wireUsage(zeroUsage));
  });

  it('reports zero for local stream validation failure before request_started', async () => {
    stream.mockImplementation(() => { throw new AppError('MODEL_CAPABILITY_UNSUPPORTED'); });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'model_capability_unsupported' } });
    expect(runUsage(accepted.runId)).toEqual(wireUsage(zeroUsage));
  });

  it('rejects invalid input, stale tips and failed user writes without creating accepted-run events', async () => {
    for (const invalid of [
      { sessionId: 'session', input: { text: ' ' }, expectedTipEntryId: null },
      { sessionId: 'session', input: { text: 'Input' } },
      { sessionId: 'session', input: { text: 'Input' }, expectedTipEntryId: null, requestId: 'not-supported' },
      { sessionId: 'session', input: { text: 'Input' }, expectedTipEntryId: 'stale' },
    ]) expect(() => narrative.submit(invalid as SubmitInput)).toThrow();
    const append = vi.spyOn(services.sessions, 'appendEntry');
    append.mockImplementationOnce(() => { throw new AppError('STORAGE_BUSY'); });
    expect(() => narrative.submit({ sessionId: 'session', input: { text: 'Input' }, expectedTipEntryId: null })).toThrow('STORAGE_BUSY');
    expect(history()).toEqual([]);
    expect(seen).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
    expect((await submit().finished).event).toBe('run.completed');
  });

  it.each(['completed', 'provider_error', 'cancelled', 'server_shutdown'] as const)(
    'gives real assistant persistence failure precedence over %s without rolling back the user', async ending => {
      db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON entries WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'simulated assistant write failure'); END");
      if (ending === 'provider_error') script([text('半段'), failure('provider_error', '半段')]);
      const { accepted, finished } = submit();
      let stopped = false;
      events.subscribe('session', event => {
        if (event.event !== 'run.delta' || stopped) return;
        stopped = true;
        if (ending === 'cancelled') narrative.stop('session', accepted.runId);
        if (ending === 'server_shutdown') void narrative.shutdown();
      });
      expect(await finished).toMatchObject({ event: 'run.stopped', data: {
        stop_reason: 'message_persist_failed', savedMessageIds: [accepted.userEntryId], tipEntryId: accepted.userEntryId,
      } });
      expect(texts()).toEqual(['玩家输入']);
      expect(services.sessions.listEntryRuns('session').items.find(item => item.runId === accepted.runId)!.entries).toHaveLength(1);
    },
  );

  it('blocks external appends during generation and keeps the run tip intact', async () => {
    let blocked: unknown;
    events.subscribe('session', event => {
      if (event.event !== 'run.delta' || blocked) return;
      try {
        services.sessions.appendEntry('session', {
          id: 'external', parentId: services.sessions.require('session').tipEntryId, runId: 'external-run', type: 'message', role: 'assistant',
          payload: { message: { role: 'assistant', content: '外部追加', timestamp: 1 } },
        });
      } catch (error) { blocked = error; }
    });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.completed', data: {
      savedMessageIds: [accepted.userEntryId, accepted.assistantEntryId], tipEntryId: accepted.assistantEntryId,
    } });
    expect(blocked).toMatchObject({ code: 'SESSION_WRITE_LOCKED' });
    expect(texts()).toEqual(['玩家输入', '完整正文']);
    expect(services.sessions.getEntry('session', 'external')).toBeNull();
  });

  it('blocks deletion during generation and permits it after settlement', async () => {
    let blocked: unknown;
    events.subscribe('session', event => {
      if (event.event !== 'run.delta' || blocked) return;
      try { services.sessions.delete('session'); } catch (error) { blocked = error; }
    });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.completed', data: {
      savedMessageIds: [accepted.userEntryId, accepted.assistantEntryId], tipEntryId: accepted.assistantEntryId,
    } });
    expect(blocked).toMatchObject({ code: 'SESSION_WRITE_LOCKED' });
    expect(runUsage(accepted.runId)).toEqual(wireUsage(usage));
    expect(services.sessions.delete('session')).toBe(true);
  });
});

describe('cancellation, shutdown and observer isolation', () => {
  it('rejects concurrent runs in one session while allowing another session to finish', async () => {
    createSession('second');
    const held = deferred<void>();
    stream.mockImplementation(async function* (_model, messages) {
      yield { type: 'request_started' };
      if (messages.filter(message => message.role === 'user').at(-1)?.content === '等待') await held.promise;
      yield done('各自正文');
    });
    const first = submit('等待');
    expect(() => narrative.submit({
      sessionId: 'session', input: { text: '重复' }, expectedTipEntryId: first.accepted.userEntryId,
    })).toThrow('RUN_ALREADY_ACTIVE');
    expect((await submit('另一个会话', 'second').finished).event).toBe('run.completed');
    narrative.stop('session', first.accepted.runId);
    expect(await first.finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'cancelled' } });
    held.resolve();
  });

  it('stops before execution without attempting a model request', async () => {
    const { accepted, finished } = submit();
    narrative.stop('session', accepted.runId);
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'cancelled' } });
    expect(runUsage(accepted.runId)).toEqual(wireUsage(zeroUsage));
    expect(stream).not.toHaveBeenCalled();
  });

  it('records an attempted request when synchronous cancellation precedes its queued request_started notification', async () => {
    let runId = '';
    stream.mockImplementation(async function* () {
      // Mirrors an SDK invocation that synchronously triggers shutdown/stop before the async yield is delivered.
      narrative.stop('session', runId);
      yield { type: 'request_started' };
      yield done('late');
    });
    const request = submit();
    runId = request.accepted.runId;
    expect(await request.finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'cancelled' } });
    expect(runUsage(runId)).toBeNull();
    expect(texts()).toEqual(['玩家输入']);
  });

  it('cancels an unresponsive first next and ignores its marker if it arrives after settlement', async () => {
    const held = deferred<void>(), waiting = deferred<void>();
    let resumed = false;
    stream.mockImplementation(async function* () {
      waiting.resolve();
      await held.promise;
      resumed = true;
      yield { type: 'request_started' };
      yield done('late');
    });
    const request = submit();
    await waiting.promise;
    narrative.stop('session', request.accepted.runId);
    expect(await request.finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'cancelled' } });
    expect(runUsage(request.accepted.runId)).toEqual(wireUsage(zeroUsage));
    const settled = structuredClone(seen);
    held.resolve();
    await vi.waitFor(() => expect(resumed).toBe(true));
    expect(seen).toEqual(settled);
    expect(texts()).toEqual(['玩家输入']);
  });

  it('saves partial reasoning and text when a delta observer cancels, without fetching another delta', async () => {
    let resumed = false;
    stream.mockImplementation(async function* () {
      yield { type: 'request_started' };
      yield { type: 'delta', delta: { content: '半段', reasoning_content: '公开思考' } };
      resumed = true;
      yield done('迟到结果');
    });
    const { accepted, finished } = submit();
    let stopped = false;
    events.subscribe('session', event => {
      if (event.event === 'run.delta' && !stopped) {
        stopped = true;
        narrative.stop('session', accepted.runId);
      }
    });
    expect(await finished).toMatchObject({ event: 'run.stopped', data: {
      stop_reason: 'cancelled', savedMessageIds: [accepted.userEntryId, accepted.assistantEntryId],
    } });
    expect(resumed).toBe(false);
    expect(history()[1]!.payload.message).toMatchObject(snapshot('半段', { reasoning_content: '公开思考' }));
    expect(history()[1]!.metrics!.requests[0]).not.toHaveProperty('status');
    expect(history()[0]!.extData.narrative).toMatchObject({ status: 'stopped', stopReason: 'cancelled' });
    expect(finalMessage()).toMatchObject({ snapshot: snapshot('半段', { reasoning_content: '公开思考' }) });
    expect(finalMessage()).not.toHaveProperty('finish_reason');
    expect(runUsage(accepted.runId)).toBeNull();
    expect(() => narrative.stop('session', accepted.runId)).toThrow('RUN_NOT_FOUND');
  });

  it('cancels a hung credential lookup without waiting for or using its late secret', async () => {
    const held = deferred<string | null>();
    const get = vi.spyOn(services.credentials, 'get').mockReturnValue(held.promise);
    const { accepted, finished } = submit();
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    expect(() => narrative.stop('session', 'different-run')).toThrow('RUN_NOT_FOUND');
    narrative.stop('session', accepted.runId);
    expect(await finished).toMatchObject({ event: 'run.stopped', data: {
      stop_reason: 'cancelled', savedMessageIds: [accepted.userEntryId], tipEntryId: accepted.userEntryId,
    } });
    held.resolve('late-private-secret');
    await Promise.resolve();
    expect(stream).not.toHaveBeenCalled();
    expect(runUsage(accepted.runId)).toEqual(wireUsage(zeroUsage));
  });

  it('retains the first cancellation reason if shutdown follows user cancellation', async () => {
    const { accepted, finished } = submit();
    narrative.stop('session', accepted.runId);
    await narrative.shutdown();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'cancelled' } });
  });

  it('settles before shutdown resolves and discards late provider output and usage', async () => {
    const held = deferred<void>(), waiting = deferred<void>();
    stream.mockImplementation(async function* () {
      yield { type: 'request_started' };
      yield text('关机前正文');
      waiting.resolve();
      await held.promise;
      yield done('迟到输出', { usage: { ...usage, totalTokens: 999 } });
    });
    const { accepted, finished } = submit();
    await waiting.promise;
    const closing = narrative.shutdown();
    expect(narrative.shutdown()).toBe(closing);
    expect(() => narrative.submit({
      sessionId: 'session', input: { text: '关闭后的输入' }, expectedTipEntryId: accepted.userEntryId,
    })).toThrow('SERVER_SHUTTING_DOWN');
    await closing;
    expect(seen.at(-1)).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'server_shutdown' } });
    expect(services.sessions.getEntry('session', accepted.assistantEntryId)).not.toBeNull();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: {
      stop_reason: 'server_shutdown', savedMessageIds: [accepted.userEntryId, accepted.assistantEntryId],
    } });
    expect(texts()).toEqual(['玩家输入', '关机前正文']);
    expect(runUsage(accepted.runId)).toBeNull();
    const saved = structuredClone(seen);
    const append = vi.spyOn(services.sessions, 'appendEntry');
    const appendAssistant = vi.spyOn(services.sessions, 'appendNarrativeAssistant');
    held.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(append).not.toHaveBeenCalled();
    expect(appendAssistant).not.toHaveBeenCalled();
    expect(seen).toEqual(saved);
    expect(finalMessage()).not.toHaveProperty('finish_reason');
  });

  it('waits for settlement when shutdown is requested synchronously from run.created', async () => {
    let closing: Promise<void> | undefined;
    const created = deferred<void>();
    events.subscribe('session', event => {
      if (event.event === 'run.created') {
        closing = narrative.shutdown();
        created.resolve();
      }
    });
    const { accepted, finished } = submit();
    await created.promise;
    await closing;
    expect(seen.at(-1)).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'server_shutdown' } });
    expect(runUsage(accepted.runId)).toEqual(wireUsage(zeroUsage));
    expect(texts()).toEqual(['玩家输入']);
    expect((await finished).event).toBe('run.stopped');
  });

  it('does not confuse a finished model message with a run cancelled before saving it', async () => {
    const { accepted, finished } = submit();
    events.subscribe('session', event => {
      if (event.event === 'run.delta' && (event as Extract<NarrativeEvent, { event: 'run.delta' }>).data.messages[0].snapshot) {
        narrative.stop('session', accepted.runId);
      }
    });
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'cancelled' } });
    expect(finalMessage()?.finish_reason).toBe('stop');
    expect(runUsage(accepted.runId)).toEqual(wireUsage(usage));
    expect(history()[1]!.metrics!.requests[0]).not.toHaveProperty('status');
    expect(history()[0]!.extData.narrative).toMatchObject({ status: 'stopped', stopReason: 'cancelled' });
  });

  it('isolates throwing observers and their mutation of final snapshot data from persistence', async () => {
    events.subscribe('session', () => { throw new Error('broken observer'); });
    events.subscribe('session', event => {
      if (event.event !== 'run.delta') return;
      const message = (event as Extract<NarrativeEvent, { event: 'run.delta' }>).data.messages[0];
      if (message.snapshot) message.snapshot.content = 'observer mutation';
    });
    expect((await submit().finished).event).toBe('run.completed');
    expect(texts()).toEqual(['玩家输入', '完整正文']);
  });

  it('releases admission before usage and terminal observers, and permits immediate next-turn submission', async () => {
    const next = deferred<NarrativeTerminalEvent>();
    let firstRunId = '', noActiveAtUsage = false;
    events.subscribe('session', event => {
      if (event.data.runId !== firstRunId) return;
      if (event.event === 'run.usage') {
        try { narrative.stop('session', firstRunId); }
        catch (error) { noActiveAtUsage = error instanceof AppError && error.code === 'RUN_NOT_FOUND'; }
      }
      if (event.event === 'run.completed') void submit('紧接下一轮').finished.then(next.resolve);
    });
    const first = submit();
    firstRunId = first.accepted.runId;
    await first.finished;
    expect((await next.promise).event).toBe('run.completed');
    expect(noActiveAtUsage).toBe(true);
    expect(texts()).toEqual(['玩家输入', '完整正文', '紧接下一轮', '完整正文']);
  });
});

describe('queryable narrative results', () => {
  it('exposes active state then a durable outcome without in-memory text snapshots', async () => {
    const { accepted, finished } = submit();
    expect(narrative.list('session').activeRunId).toBe(accepted.runId);
    expect(narrative.list('session').items.find(item => item.runId === accepted.runId)!).toMatchObject({ status: 'running', entries: [{ id: accepted.userEntryId }] });
    await finished;
    expect(narrative.list('session').activeRunId).toBeNull();
    expect(narrative.list('session').items.find(item => item.runId === accepted.runId)!).toMatchObject({ status: 'completed', finishedAt: expect.any(Number) });
    expect(history()[0]!.extData.narrative).toMatchObject({ status: 'completed' });
    expect(history()[1]!.metrics!.requests[0]).toMatchObject({ provider: model.providerId, modelId: model.modelId });
    expect(history()[1]!.metrics!.requests[0]).not.toHaveProperty('status');
    const context = history()[1]!.metrics!.context!;
    expect(context).toMatchObject({ requestId: history()[1]!.metrics!.requests[0]!.requestId,
      apiModelConfigId: 'model', contextWindowTokens: model.contextWindow });
    expect(context.contextComposition.historyBytes).toBeGreaterThan(0);
    expect(narrative.usage('session')).toEqual({ knownUsage: usage, recordedRequestCount: 1, unknownUsageRequestCount: 0,
      latestContext: { inputTokens: usage.inputTokens, contextWindowTokens: model.contextWindow, modelId: model.modelId,
        stale: false, contextComposition: context.contextComposition } });
    const reloaded = createNarrativeUsecases({ ...services, events, transaction: bindTransaction(db), modelClient: { resolve: resolveModel, assertMessageOrder: vi.fn(), stream } });
    expect(reloaded.list('session').items.find(item => item.runId === accepted.runId)!.status).toBe('completed');
  });

  it('records preparation failure on the user even when no assistant or metrics exists', async () => {
    resolveModel.mockImplementationOnce(() => { throw new AppError('MODEL_NOT_FOUND'); });
    const { accepted, finished } = submit();
    await finished;
    expect(narrative.list('session').items.find(item => item.runId === accepted.runId)!).toMatchObject({
      status: 'stopped', stopReason: 'model_not_found', entries: [{ id: accepted.userEntryId }],
    });
    expect(narrative.usage('session').recordedRequestCount).toBe(0);
  });

  it('saves partial output and a cancellation outcome before publishing the terminal event', async () => {
    script([text('半截'), done('不应读取')]);
    const { accepted, finished } = submit();
    let stopped = false;
    let observed: unknown;
    events.subscribe('session', event => {
      if (event.event === 'run.delta' && !stopped) {
        stopped = true; narrative.stop('session', accepted.runId);
      }
      if (event.event === 'run.stopped') observed = narrative.list('session').items.find(item => item.runId === accepted.runId)!;
    });
    await finished;
    expect(observed).toMatchObject({ status: 'stopped', stopReason: 'cancelled' });
    const after = narrative.list('session', { afterSeq: history()[0]!.seq });
    expect(after.items).toHaveLength(1);
    expect(after.items[0]!.entries.map(entry => entry.seq)).toEqual([1, 2]);
    expect(texts()).toEqual(['玩家输入', '半截']);
  });

  it('does not roll back saved messages or fabricate an outcome if settlement storage fails', async () => {
    vi.spyOn(services.sessions, 'setNarrativeOutcome').mockImplementationOnce(() => { throw new AppError('STORAGE_BUSY'); });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'message_persist_failed' } });
    expect(texts()).toEqual(['玩家输入', '完整正文']);
    expect(narrative.list('session').items.find(item => item.runId === accepted.runId)!.status).toBe('unknown');
    expect(history()[0]!.extData).toEqual({});
  });
});


function readLogs(runId?: string) {
  return logLines.map(line => {
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/u);
    const match = /^\[[^\]]+\] \[([^\]]+)\] \[(.*)\]$/u.exec(line);
    if (!match) throw new Error('Invalid run log: ' + line);
    return { event: match[1]!, data: JSON.parse(match[2]!) as Record<string, unknown> };
  }).filter(item => runId === undefined || item.data.runId === runId);
}

describe('run diagnostic logs', () => {
  it('records the complete run in order without delta or a duplicate model-input log', async () => {
    stream.mockImplementation(async function* (_model, messages, options) {
      options.onDiagnostic?.({ type: 'request', source: 'provider_payload',
        data: { model: 'story-model', messages, apiKey: 'private-test-secret' } });
      yield { type: 'request_started' };
      yield text('完整');
      options.onDiagnostic?.({ type: 'response', source: 'sdk_message',
        data: { role: 'assistant', content: [{ type: 'text', text: '完整正文' }], usage: { input: 20, output: 5 } } });
      yield done();
    });
    const { accepted, finished } = submit('第一行\n第二行');
    const terminalEvent = await finished;
    const logs = readLogs(accepted.runId);
    expect(logs.map(item => item.event)).toEqual([
      'run.created', 'context.completed', 'model.request', 'model.response', 'postprocess.started',
      'state_update.raw', 'state_update.result', 'action_suggestions.raw', 'action_suggestions.result',
      'postprocess.completed', 'run.usage', 'run.completed',
    ]);
    expect(logs[0]!.data).toMatchObject({ runId: accepted.runId, sessionId: 'session',
      messages: [{ content: '第一行\n第二行' }] });
    expect(logs.find(item => item.event === 'context.completed')!.data).toMatchObject({
      nodes: expect.any(Array), characters: expect.any(Array), lore: expect.any(Array),
    });
    expect(JSON.stringify(logs.find(item => item.event === 'context.completed'))).not.toContain('第一行');
    expect(logs.find(item => item.event === 'model.request')!.data).toMatchObject({
      purpose: 'narrative', provider: model.providerId, model: model.modelId, source: 'provider_payload',
      raw: { messages: expect.any(Array) },
    });
    expect(logs.find(item => item.event === 'model.response')!.data).toMatchObject({
      purpose: 'narrative', source: 'sdk_message',
      raw: { content: [{ type: 'text', text: '完整正文' }], usage: { input: 20, output: 5 } },
    });
    expect(logs.find(item => item.event === 'run.usage')!.data).toEqual(
      seen.find(item => item.event === 'run.usage')!.data);
    expect(logs.at(-1)!.data).toEqual(terminalEvent.data);
    expect(logLines.join('\n')).not.toContain('private-test-secret');
  });

  it('logs accepted creation before an immediate stop and includes the actual stopped result', async () => {
    const { accepted, finished } = submit('立即停止');
    narrative.stop('session', accepted.runId);
    const terminalEvent = await finished;
    const logs = readLogs(accepted.runId);
    expect(logs.slice(0, 2).map(item => item.event)).toEqual(['run.created', 'run.stop_requested']);
    expect(logs.at(-1)).toEqual({ event: 'run.stopped', data: terminalEvent.data });
    expect(logs.filter(item => item.event === 'run.usage')).toHaveLength(1);
    expect(logs.some(item => item.event === 'postprocess.started')).toBe(false);
    expect(stream).not.toHaveBeenCalled();
  });

  it('records context failure without claiming a completed build or model request', async () => {
    resolveModel.mockImplementation(() => { throw new AppError('MODEL_NOT_FOUND'); });
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.stopped');
    const logs = readLogs(accepted.runId);
    expect(logs.map(item => item.event)).toEqual(['run.created', 'context.failed', 'run.usage', 'run.stopped']);
    expect(logs[1]!.data).toMatchObject({ failure: { code: 'MODEL_NOT_FOUND' } });
  });

  it('keeps persistence, usage and completion intact when the log writer throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('log writer unavailable'); });
    const { accepted, finished } = submit();
    expect((await finished).event).toBe('run.completed');
    expect(history().map(entry => entry.id)).toEqual([accepted.userEntryId, accepted.assistantEntryId]);
    expect(runUsage(accepted.runId)).toEqual(wireUsage(usage));
  });
});
