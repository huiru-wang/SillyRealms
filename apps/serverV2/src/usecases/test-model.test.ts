import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { openDatabase } from '../infrastructure/database/connection.js';
import type { ModelClient, ModelEvent, ModelInfo, ModelSnapshot, ModelUsage } from '../infrastructure/model/client.js';
import { CredentialService } from '../modules/credentials/service.js';
import { ModelService } from '../modules/models/service.js';
import { memoryCredentials } from '../testing/credentials.js';
import { createTestModel } from './test-model.js';

let db: DatabaseSync;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

const model: ModelInfo = {
  providerId: 'test', modelId: 'test-model', name: 'Test model', api: 'openai-completions',
  input: ['text'], reasoning: false, contextWindow: 8192, maxTokens: 8,
  thinkingLevels: ['off'], thinkingLevelMap: null, promptCache: null,
  narrativeCompatible: true, supportsMidConversationSystemMessages: true,
};
const usage: ModelUsage = { inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 };
const snapshot = (content = 'OK'): ModelSnapshot => ({ role: 'assistant', content, reasoning_content: '', tool_calls: [] });
const done: ModelEvent = { type: 'done', snapshot: snapshot(), finishReason: 'stop', usage };

async function setup(events: ModelEvent[] = [{ type: 'request_started' }, { type: 'delta', delta: { content: 'OK' } }, done]) {
  const store = memoryCredentials(), models = new ModelService(db);
  const credentials = new CredentialService('/test/v2-model-test', store);
  const config = models.create({
    id: 'saved-model', name: 'Saved configuration', providerId: model.providerId, modelId: model.modelId,
    credentialRef: credentials.referenceFor('saved-model'),
  });
  await credentials.set(config.credentialRef, 'test-only-secret');
  const modelClient = {
    resolve: vi.fn<ModelClient['resolve']>(() => model),
    assertMessageOrder: vi.fn<ModelClient['assertMessageOrder']>(),
    stream: vi.fn<ModelClient['stream']>(async function* () { yield* events; }),
  };
  return { config, store, models, credentials, modelClient, testModel: createTestModel({ models, credentials, modelClient }) };
}

function noNarrativeRecords() {
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()?.count).toBe(0);
  expect(db.prepare('SELECT count(*) AS count FROM entries').get()?.count).toBe(0);
}

describe('saved model connection test', () => {
  it('makes one bounded request from saved configuration and returns only safe fields', async () => {
    const { config, modelClient, testModel } = await setup();
    const result = await testModel(config.id);
    expect(result).toEqual({ providerId: 'test', modelId: 'test-model', connected: true, durationMs: expect.any(Number), usage });
    expect(modelClient.resolve).toHaveBeenCalledWith(config.providerId, config.modelId);
    expect(modelClient.stream).toHaveBeenCalledOnce();
    const [selected, messages, options] = modelClient.stream.mock.calls[0]!;
    expect(selected).toBe(model);
    expect(messages).toEqual([{ role: 'user', content: 'Reply with OK.' }]);
    expect(options).toMatchObject({ apiKey: 'test-only-secret', maxTokens: 8, thinkingEnabled: false });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toMatch(/test-only-secret|credentialRef|Reply with OK|\"text\"/);
    noNarrativeRecords();
  });

  it('accepts a final response without deltas and preserves unknown usage as null', async () => {
    const { config, testModel } = await setup([{ ...done, usage: null }]);
    expect(await testModel(config.id)).toMatchObject({ connected: true, usage: null });
  });

  it('rejects missing saved configuration, unknown model and absent credentials before sending', async () => {
    const { config, modelClient, credentials, testModel } = await setup();
    await expect(testModel('absent')).rejects.toMatchObject({ code: 'MODEL_CONFIG_NOT_FOUND' });
    modelClient.resolve.mockImplementationOnce(() => { throw new AppError('MODEL_NOT_FOUND'); });
    await expect(testModel(config.id)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    await credentials.delete(config.credentialRef);
    await expect(testModel(config.id)).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONFIGURED' });
    expect(modelClient.stream).not.toHaveBeenCalled();
    noNarrativeRecords();
  });

  it.each([
    ['missing terminal', [{ type: 'delta', delta: { content: 'partial' } }], 'MODEL_OUTPUT_INCOMPLETE'],
    ['truncated', [{ ...done, finishReason: 'length' }], 'MODEL_OUTPUT_INCOMPLETE'],
    ['deferred', [{ ...done, finishReason: 'deferred' }], 'MODEL_OUTPUT_INCOMPLETE'],
    ['empty', [{ ...done, snapshot: snapshot(' ') }], 'MODEL_OUTPUT_INVALID'],
    ['tools', [{ ...done, snapshot: { ...snapshot(), tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'tool', arguments: '{}' } }] } }], 'MODEL_OUTPUT_INVALID'],
    ['provider error', [{ type: 'error', stopReason: 'context_window_exceeded', snapshot: snapshot('test-only-secret'), usage: null }], 'PROVIDER_CONTEXT_WINDOW_EXCEEDED'],
  ] as const)('rejects %s without persisting anything or retrying', async (_name, events, code) => {
    const { config, modelClient, testModel } = await setup([...events] as ModelEvent[]);
    await expect(testModel(config.id)).rejects.toMatchObject({ code, message: code });
    expect(modelClient.stream).toHaveBeenCalledOnce();
    noNarrativeRecords();
  });

  it('uses the authoritative final snapshot even when public deltas were corrected', async () => {
    const { config, testModel } = await setup([
      { type: 'request_started' },
      { type: 'delta', delta: { reasoning_content: 'model reasoning' } },
      { type: 'delta', delta: { content: 'provisional text' } },
      done,
    ]);
    expect(await testModel(config.id)).toMatchObject({ connected: true, usage });
    noNarrativeRecords();
  });

  it('does not expose raw provider exceptions or error detail', async () => {
    const { config, modelClient, testModel } = await setup();
    modelClient.stream.mockImplementationOnce(() => { throw new Error('private provider response: test-only-secret'); });
    await expect(testModel(config.id)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: 'PROVIDER_ERROR' });
    modelClient.stream.mockImplementationOnce(() => { throw new AppError('PROVIDER_ERROR', 'test-only-secret'); });
    await expect(testModel(config.id)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: 'PROVIDER_ERROR' });
  });

  it('cancels credential waiting without sending a request or using a late credential', async () => {
    const { config, store, modelClient, testModel } = await setup();
    let release!: (secret: string) => void;
    store.get = () => new Promise<string>(resolve => { release = resolve; });
    const controller = new AbortController();
    const pending = testModel(config.id, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'RUN_STOPPED' });
    controller.abort();
    await rejected;
    release('late-test-only-secret');
    await Promise.resolve();
    expect(modelClient.stream).not.toHaveBeenCalled();
    noNarrativeRecords();
  });

  it('cancels a provider that ignores AbortSignal without waiting for generator cleanup', async () => {
    const { config, modelClient, testModel } = await setup();
    let entered!: () => void;
    const streaming = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    modelClient.stream.mockImplementation(async function* () { entered(); await delayed; yield done; });
    const controller = new AbortController();
    const pending = testModel(config.id, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'RUN_STOPPED' });
    await streaming;
    controller.abort();
    await rejected;
    release();
    noNarrativeRecords();
  });

  it('bounds an unresponsive credential lookup and cleans up the timeout', async () => {
    const { config, store, modelClient, testModel } = await setup();
    vi.useFakeTimers();
    store.get = () => new Promise(() => {});
    const pending = testModel(config.id);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(modelClient.stream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a pre-aborted test and clears timers after success', async () => {
    const { config, modelClient, testModel } = await setup();
    vi.useFakeTimers();
    await expect(testModel(config.id, AbortSignal.abort())).rejects.toMatchObject({ code: 'RUN_STOPPED' });
    expect(modelClient.resolve).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(testModel(config.id)).resolves.toMatchObject({ connected: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
