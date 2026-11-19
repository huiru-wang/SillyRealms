import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors.js';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { EventHub, type SessionEvent } from '../../infrastructure/events/event-hub.js';
import type { PiClient, PiEvent, PiModel, PiUsage } from '../../infrastructure/pi/client.js';
import { createServices, type Services } from '../../services.js';
import { memoryCredentials } from '../../testing/credentials.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { createNarrativeUsecases, type NarrativeUsecases, type SubmitInput } from './index.js';

const model: PiModel = {
  id: 'story-model', name: 'Story model', provider: 'test-provider', api: 'openai-completions',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 8192,
};
const usage: PiUsage = { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 0 };
const done = (text = '完整正文', extra: Partial<Extract<PiEvent, { type: 'done' }>> = {}): PiEvent => ({
  type: 'done', text, stopReason: 'stop', hasToolCalls: false, usage, ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let db: DatabaseSync, services: Services, dataRoot: string;
let events: EventHub, narrative: NarrativeUsecases, seen: SessionEvent[];
let stream: ReturnType<typeof vi.fn<PiClient['stream']>>;
let resolveModel: ReturnType<typeof vi.fn<PiClient['resolve']>>;

beforeEach(async () => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-narrative-run-'));
  services = createServices(db, dataRoot, memoryCredentials());
  const credentialRef = services.credentials.referenceFor('model');
  await services.credentials.set(credentialRef, 'private-test-secret');
  services.models.create({ id: 'model', name: 'Model', providerId: model.provider, modelId: model.id, credentialRef });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', name: 'World', specVersion: '0.1', state: { day: 1 },
    characters: [{ id: 'player', name: 'Player', player_selectable: true }],
    openings: [{ id: 'start', name: 'Start', content: 'An unused opening' }],
  });
  createSession('session');
  events = new EventHub();
  seen = [];
  events.subscribe('session', event => seen.push(event));
  stream = vi.fn<PiClient['stream']>(async function* () {
    yield { type: 'text_delta', delta: '完整' };
    yield { type: 'text_delta', delta: '正文' };
    yield done();
  });
  resolveModel = vi.fn<PiClient['resolve']>(() => model);
  narrative = createNarrativeUsecases({
    ...services, events, pi: { resolve: resolveModel, assertMessageOrder: vi.fn(), stream },
  });
});

afterEach(async () => {
  await narrative.shutdown();
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
  return new Promise<SessionEvent>(resolve => {
    const unsubscribe = events.subscribe(sessionId, event => {
      if (['run.completed', 'run.failed', 'run.stopped'].includes(event.event)) {
        unsubscribe();
        resolve(event);
      }
    });
  });
}
function submit(text = '玩家输入', sessionId = 'session') {
  const finished = terminal(sessionId);
  const accepted = narrative.submit({
    sessionId, input: { text }, expectedTipEntryId: services.sessions.require(sessionId).tipEntryId,
  });
  return { accepted, finished };
}
function history(sessionId = 'session') { return services.sessions.getHistory(sessionId); }
function texts(sessionId = 'session') { return history(sessionId).map(entry => (entry.payload.message as { content: string }).content); }
function script(items: PiEvent[]) {
  stream.mockImplementation(async function* () { for (const item of items) yield item; });
}
function assertSingleTerminal(expected: string) {
  expect(seen.filter(event => ['run.completed', 'run.failed', 'run.stopped'].includes(event.event)).map(event => event.event)).toEqual([expected]);
}

describe('narrative admission and independent persistence', () => {
  it('durably saves the user before any model work, then saves the assistant and publishes its committed tip', async () => {
    const { accepted, finished } = submit();
    expect(stream).not.toHaveBeenCalled();
    expect(resolveModel).not.toHaveBeenCalled();
    expect(texts()).toEqual(['玩家输入']);
    expect(history()[0]).toMatchObject({ id: accepted.userEntryId, runId: accepted.runId, state: null, extData: {}, metrics: null });
    expect(accepted.capabilities).toEqual({ historyPolicy: 'full', postprocess: false });

    const result = await finished;
    expect(result).toEqual({ event: 'run.completed', data: {
      runId: accepted.runId, userEntryId: accepted.userEntryId, assistantEntryId: accepted.assistantEntryId, tipEntryId: accepted.assistantEntryId,
    } });
    expect(texts()).toEqual(['玩家输入', '完整正文']);
    expect(history()[1]).toMatchObject({
      parentId: accepted.userEntryId, state: null, extData: {},
      metrics: { requests: [{ status: 'completed', modelId: 'story-model', usage }] },
    });
    expect(history()[1]!.metrics!.requests[0]!.requestId).not.toBe(accepted.runId);
    expect(seen.map(event => event.event)).toEqual(['run.started', 'message.delta', 'message.delta', 'run.completed']);
    expect(seen.filter(event => event.event === 'message.delta').map(event => event.data.offset)).toEqual([0, 2]);
    expect(stream.mock.calls[0]![1].map(message => message.content)).toEqual(['玩家输入']);
    expect(JSON.stringify(seen)).not.toContain('private-test-secret');
    expect(services.state.getGlobal('world')).toEqual({ day: 1 });
    expect(services.state.getSession('session')).toEqual({ coins: 2 });
  });

  it.each([
    { name: 'provider error', items: [
      { type: 'text_delta', delta: '半段' },
      { type: 'error', errorCode: 'PROVIDER_ERROR', text: '半段', usage },
    ], body: '半段', code: 'PROVIDER_ERROR' },
    { name: 'missing done', items: [{ type: 'text_delta', delta: '半段' }], body: '半段', code: 'MODEL_OUTPUT_INCOMPLETE' },
    { name: 'length limit with final suffix', items: [
      { type: 'text_delta', delta: '半段' }, done('半段后续', { stopReason: 'length' }),
    ], body: '半段后续', code: 'MODEL_OUTPUT_INCOMPLETE' },
    { name: 'error with final suffix', items: [
      { type: 'text_delta', delta: '半段' },
      { type: 'error', errorCode: 'PROVIDER_ERROR', text: '半段后续', usage },
    ], body: '半段后续', code: 'PROVIDER_ERROR' },
    { name: 'unexpected tool call', items: [
      { type: 'text_delta', delta: '半段' }, done('半段', { hasToolCalls: true }),
    ], body: '半段', code: 'MODEL_OUTPUT_INVALID' },
    { name: 'mismatched normal final', items: [
      { type: 'text_delta', delta: '已显示正文' }, done('另一段正文'),
    ], body: '已显示正文', code: 'MODEL_OUTPUT_INVALID' },
    { name: 'error-only body', items: [
      { type: 'error', errorCode: 'PROVIDER_CONTEXT_WINDOW_EXCEEDED', text: '终帧部分正文', usage: null },
    ], body: '终帧部分正文', code: 'PROVIDER_CONTEXT_WINDOW_EXCEEDED' },
    { name: 'done-only truncated body', items: [done('终帧部分正文', { stopReason: 'length' })],
      body: '终帧部分正文', code: 'MODEL_OUTPUT_INCOMPLETE' },
  ])('keeps the user and received body after $name', async ({ items, body, code }) => {
    script(items as PiEvent[]);
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.failed', data: {
      errorCode: code, userEntryId: accepted.userEntryId, assistantEntryId: accepted.assistantEntryId, tipEntryId: accepted.assistantEntryId,
    } });
    expect(texts()).toEqual(['玩家输入', body]);
    expect(history()[1]!.metrics!.requests[0]!.status).toBe('failed');
    expect(seen.filter(event => event.event === 'message.delta').map(event => event.data.text).join('')).toBe(body);
    assertSingleTerminal('run.failed');
  });

  it('saves a done-only successful body and supports continuing from partial failed history', async () => {
    script([{ type: 'error', errorCode: 'PROVIDER_ERROR', text: '之前的半截故事', usage: null }]);
    await submit('上一轮输入').finished;
    script([done('继续后的完整故事')]);
    const { accepted, finished } = submit('继续');
    expect(await finished).toMatchObject({ event: 'run.completed', data: { tipEntryId: accepted.assistantEntryId } });
    expect(texts()).toEqual(['上一轮输入', '之前的半截故事', '继续', '继续后的完整故事']);
    expect(stream.mock.calls[1]![1].map(message => [message.role, message.content])).toEqual([
      ['user', '上一轮输入'], ['assistant', '之前的半截故事'], ['user', '继续'],
    ]);
  });

  it('keeps streamed text and hides raw exception details when the iterator throws', async () => {
    stream.mockImplementation(async function* () {
      yield { type: 'text_delta', delta: '已生成' };
      throw new Error('key=private-test-secret, path=/private/model');
    });
    const result = await submit().finished;
    expect(result).toMatchObject({ event: 'run.failed', data: { errorCode: 'PROVIDER_ERROR' } });
    expect(texts()).toEqual(['玩家输入', '已生成']);
    expect(JSON.stringify(result)).not.toContain('private-test-secret');
    expect(JSON.stringify(result)).not.toContain('/private/model');
  });

  it.each([
    { name: 'provider error without text', events: [{ type: 'error', errorCode: 'PROVIDER_ERROR', text: '', usage: null }] },
    { name: 'empty normal answer', events: [done('')] },
    { name: 'whitespace-only answer', events: [done('  \n ')] },
    { name: 'stream without terminal or text', events: [] },
  ])('retains just the user after $name', async item => {
    script(item.events as PiEvent[]);
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.failed', data: {
      userEntryId: accepted.userEntryId, assistantEntryId: null, tipEntryId: accepted.userEntryId,
    } });
    expect(texts()).toEqual(['玩家输入']);
    expect(history()[0]!.metrics).toBeNull();
    assertSingleTerminal('run.failed');
  });

  it('keeps the user when credentials, model resolution or snapshot capture fail', async () => {
    vi.spyOn(services.credentials, 'get').mockResolvedValueOnce(null);
    expect(await submit('无凭据').finished).toMatchObject({ event: 'run.failed', data: { errorCode: 'CREDENTIAL_NOT_CONFIGURED' } });
    expect(texts()).toEqual(['无凭据']);
    resolveModel.mockImplementationOnce(() => { throw new AppError('MODEL_NOT_FOUND'); });
    expect(await submit('无模型').finished).toMatchObject({ event: 'run.failed', data: { errorCode: 'MODEL_NOT_FOUND' } });
    services.sessions.appendEntry('session', { id: 'summary', runId: 'old', type: 'compaction', role: null, payload: { summary: 'Old' } });
    expect(await submit('不支持的摘要').finished).toMatchObject({ event: 'run.failed', data: { errorCode: 'NARRATIVE_HISTORY_UNSUPPORTED' } });
    expect(history().at(-1)!.role).toBe('user');
    expect((history().at(-1)!.payload.message as { content: string }).content).toBe('不支持的摘要');
    expect(stream).not.toHaveBeenCalled();
  });

  it('rejects invalid input or stale tips before persistence and releases admission after a user write failure', async () => {
    for (const invalid of [
      { sessionId: 'session', input: { text: ' ' }, expectedTipEntryId: null },
      { sessionId: 'session', input: { text: 'Input' } },
      { sessionId: 'session', input: { text: 'Input' }, expectedTipEntryId: null, requestId: 'not-supported' },
      { sessionId: 'session', input: { text: 'Input' }, expectedTipEntryId: 'stale' },
    ]) expect(() => narrative.submit(invalid as SubmitInput)).toThrow();
    expect(history()).toEqual([]);
    const append = vi.spyOn(services.sessions, 'appendEntry');
    append.mockImplementationOnce(() => { throw new AppError('STORAGE_BUSY'); });
    expect(() => narrative.submit({ sessionId: 'session', input: { text: 'Input' }, expectedTipEntryId: null })).toThrow('STORAGE_BUSY');
    expect(history()).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
    expect((await submit().finished).event).toBe('run.completed');
  });

  it('does not roll back the user when the real database rejects the assistant insertion', async () => {
    db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON entries WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'simulated assistant write failure'); END");
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.failed', data: {
      errorCode: 'MESSAGE_PERSIST_FAILED', assistantEntryId: null, tipEntryId: accepted.userEntryId,
    } });
    expect(texts()).toEqual(['玩家输入']);
    expect(services.sessions.listRunEntries('session', accepted.runId)).toHaveLength(1);
    db.exec('DROP TRIGGER fail_assistant');
    expect((await submit('下一次输入').finished).event).toBe('run.completed');
  });

  it('reports a later tip conflict without overwriting an external entry or rolling back the user', async () => {
    let appended = false;
    events.subscribe('session', event => {
      if (event.event !== 'message.delta' || appended) return;
      appended = true;
      services.sessions.appendEntry('session', {
        id: 'external', parentId: services.sessions.require('session').tipEntryId, runId: 'external-run', type: 'message', role: 'assistant',
        payload: { message: { role: 'assistant', content: '外部追加', timestamp: 1 } },
      });
    });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.failed', data: { errorCode: 'TIP_CONFLICT', assistantEntryId: null, tipEntryId: 'external' } });
    expect(texts()).toEqual(['玩家输入', '外部追加']);
    expect(history()[0]!.id).toBe(accepted.userEntryId);
  });
});

describe('in-memory lifetime and event isolation', () => {
  it('rejects concurrent submission in one session while allowing another to finish', async () => {
    createSession('second');
    const held = deferred<void>();
    stream.mockImplementation(async function* (_model, messages) {
      if (messages.at(-1)!.content === '等待') await held.promise;
      yield done('各自正文');
    });
    const first = submit('等待');
    expect(() => narrative.submit({
      sessionId: 'session', input: { text: '重复' }, expectedTipEntryId: first.accepted.userEntryId,
    })).toThrow('RUN_ALREADY_ACTIVE');
    const second = submit('另一个会话', 'second');
    expect((await second.finished).event).toBe('run.completed');
    expect(seen.some(event => event.data.runId === second.accepted.runId)).toBe(false);
    narrative.stop('session', first.accepted.runId);
    expect((await first.finished).event).toBe('run.stopped');
    held.resolve();
    await Promise.resolve();
    expect(texts()).toEqual(['等待']);
  });

  it('saves partial text when stop is requested by a delta observer and does not fetch another delta', async () => {
    let resumed = false;
    stream.mockImplementation(async function* () {
      yield { type: 'text_delta', delta: '已收到的半段' };
      resumed = true;
      yield done('迟到结果');
    });
    const { accepted, finished } = submit();
    events.subscribe('session', event => {
      if (event.event === 'message.delta') narrative.stop('session', accepted.runId);
    });
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { assistantEntryId: accepted.assistantEntryId } });
    expect(resumed).toBe(false);
    expect(texts()).toEqual(['玩家输入', '已收到的半段']);
    expect(history()[1]!.metrics!.requests[0]!.status).toBe('cancelled');
    expect(() => narrative.stop('session', accepted.runId)).toThrow('RUN_NOT_FOUND');
    assertSingleTerminal('run.stopped');
  });

  it('cancels a hung credential lookup without waiting for or using its late secret', async () => {
    const held = deferred<string | null>();
    const get = vi.spyOn(services.credentials, 'get').mockReturnValue(held.promise);
    const { accepted, finished } = submit();
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    expect(() => narrative.stop('session', 'different-run')).toThrow('RUN_NOT_FOUND');
    narrative.stop('session', accepted.runId);
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { assistantEntryId: null, tipEntryId: accepted.userEntryId } });
    held.resolve('late-private-secret');
    await Promise.resolve();
    expect(stream).not.toHaveBeenCalled();
    expect(texts()).toEqual(['玩家输入']);
    assertSingleTerminal('run.stopped');
  });

  it('settles received text before shutdown resolves, without waiting for an uncooperative provider', async () => {
    const held = deferred<void>(), waiting = deferred<void>();
    stream.mockImplementation(async function* () {
      yield { type: 'text_delta', delta: '关机前正文' };
      waiting.resolve();
      await held.promise;
      yield done('关机前正文迟到输出');
    });
    const { accepted, finished } = submit();
    await waiting.promise;
    const closing = narrative.shutdown();
    expect(narrative.shutdown()).toBe(closing);
    expect(() => narrative.submit({
      sessionId: 'session', input: { text: '关闭后的输入' }, expectedTipEntryId: accepted.userEntryId,
    })).toThrow('SERVER_SHUTTING_DOWN');
    await closing;
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { assistantEntryId: accepted.assistantEntryId } });
    expect(texts()).toEqual(['玩家输入', '关机前正文']);
    const append = vi.spyOn(services.sessions, 'appendEntry');
    held.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(append).not.toHaveBeenCalled();
    assertSingleTerminal('run.stopped');
  });

  it('finishes without subscribers and isolates a throwing observer from persistence', async () => {
    const remove = events.subscribe('session', () => { throw new Error('broken observer'); });
    const request = submit();
    remove();
    events.subscribe('session', () => { throw new Error('another broken observer'); });
    expect((await request.finished).event).toBe('run.completed');
    expect(texts()).toEqual(['玩家输入', '完整正文']);
  });

  it('releases admission before terminal observers submit the next turn', async () => {
    const next = deferred<SessionEvent>();
    let firstRunId = '';
    events.subscribe('session', event => {
      if (event.event !== 'run.completed' || event.data.runId !== firstRunId) return;
      expect(() => narrative.stop('session', firstRunId)).toThrow('RUN_NOT_FOUND');
      const following = submit('紧接下一轮');
      void following.finished.then(next.resolve);
    });
    const first = submit();
    firstRunId = first.accepted.runId;
    await first.finished;
    expect((await next.promise).event).toBe('run.completed');
    expect(texts()).toEqual(['玩家输入', '完整正文', '紧接下一轮', '完整正文']);
  });
});
