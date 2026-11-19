import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { openDatabase } from '../infrastructure/database/connection.js';
import type { PiClient, PiEvent, PiModel, PiUsage } from '../infrastructure/pi/client.js';
import { CredentialService } from '../modules/credentials/service.js';
import { ModelService } from '../modules/models/service.js';
import { memoryCredentials } from '../testing/credentials.js';
import { createTestModel } from './test-model.js';

let db: DatabaseSync;
beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); db.close(); });

const model: PiModel = {
  provider: 'test', id: 'test-model', name: 'Test model', api: 'openai-completions',
  baseUrl: 'https://unused.invalid', input: ['text'], reasoning: false,
  contextWindow: 8192, maxTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage: PiUsage = { inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 };
const done: PiEvent = { type: 'done', text: 'OK', stopReason: 'stop', hasToolCalls: false, usage };

async function setup(events: PiEvent[] = [{ type: 'text_delta', delta: 'OK' }, done]) {
  const store = memoryCredentials(), models = new ModelService(db);
  const credentials = new CredentialService('/test/v2-model-test', store);
  const config = models.create({
    id: 'saved-model', name: 'Saved configuration', providerId: model.provider, modelId: model.id,
    credentialRef: credentials.referenceFor('saved-model'),
  });
  await credentials.set(config.credentialRef, 'test-only-secret');
  const pi = {
    resolve: vi.fn<PiClient['resolve']>(() => model),
    assertMessageOrder: vi.fn<PiClient['assertMessageOrder']>(),
    stream: vi.fn<PiClient['stream']>(async function* () { yield* events; }),
  };
  return { config, store, models, credentials, pi, testModel: createTestModel({ models, credentials, pi }) };
}

function noNarrativeRecords() {
  expect(db.prepare('SELECT count(*) AS count FROM sessions').get()?.count).toBe(0);
  expect(db.prepare('SELECT count(*) AS count FROM entries').get()?.count).toBe(0);
}

describe('saved model connection test', () => {
  it('makes one bounded request from saved configuration and returns only safe fields', async () => {
    const { config, pi, testModel } = await setup();
    const result = await testModel(config.id);
    expect(result).toEqual({ providerId: 'test', modelId: 'test-model', connected: true, durationMs: expect.any(Number), usage });
    expect(pi.resolve).toHaveBeenCalledWith(config.providerId, config.modelId);
    expect(pi.stream).toHaveBeenCalledOnce();
    const [selected, messages, options] = pi.stream.mock.calls[0]!;
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
    const { config, pi, credentials, testModel } = await setup();
    await expect(testModel('absent')).rejects.toMatchObject({ code: 'MODEL_CONFIG_NOT_FOUND' });
    pi.resolve.mockImplementationOnce(() => { throw new AppError('MODEL_NOT_FOUND'); });
    await expect(testModel(config.id)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
    await credentials.delete(config.credentialRef);
    await expect(testModel(config.id)).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONFIGURED' });
    expect(pi.stream).not.toHaveBeenCalled();
    noNarrativeRecords();
  });

  it.each([
    ['missing terminal', [{ type: 'text_delta', delta: 'partial' }], 'MODEL_OUTPUT_INCOMPLETE'],
    ['truncated', [{ ...done, stopReason: 'length' }], 'MODEL_OUTPUT_INCOMPLETE'],
    ['empty', [{ ...done, text: ' ' }], 'MODEL_OUTPUT_INVALID'],
    ['tools', [{ ...done, hasToolCalls: true }], 'MODEL_OUTPUT_INVALID'],
    ['inconsistent', [{ type: 'text_delta', delta: 'different' }, done], 'MODEL_OUTPUT_INVALID'],
    ['provider error', [{ type: 'error', errorCode: 'PROVIDER_CONTEXT_WINDOW_EXCEEDED', text: 'test-only-secret', usage: null }], 'PROVIDER_CONTEXT_WINDOW_EXCEEDED'],
  ] as const)('rejects %s without persisting anything or retrying', async (_name, events, code) => {
    const { config, pi, testModel } = await setup([...events] as PiEvent[]);
    await expect(testModel(config.id)).rejects.toMatchObject({ code, message: code });
    expect(pi.stream).toHaveBeenCalledOnce();
    noNarrativeRecords();
  });

  it('does not expose raw provider exceptions or error detail', async () => {
    const { config, pi, testModel } = await setup();
    pi.stream.mockImplementationOnce(() => { throw new Error('private provider response: test-only-secret'); });
    await expect(testModel(config.id)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: 'PROVIDER_ERROR' });
    pi.stream.mockImplementationOnce(() => { throw new AppError('PROVIDER_ERROR', 'test-only-secret'); });
    await expect(testModel(config.id)).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: 'PROVIDER_ERROR' });
  });

  it('cancels credential waiting without sending a request or using a late credential', async () => {
    const { config, store, pi, testModel } = await setup();
    let release!: (secret: string) => void;
    store.get = () => new Promise<string>(resolve => { release = resolve; });
    const controller = new AbortController();
    const pending = testModel(config.id, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'RUN_STOPPED' });
    controller.abort();
    await rejected;
    release('late-test-only-secret');
    await Promise.resolve();
    expect(pi.stream).not.toHaveBeenCalled();
    noNarrativeRecords();
  });

  it('cancels a provider that ignores AbortSignal without waiting for generator cleanup', async () => {
    const { config, pi, testModel } = await setup();
    let entered!: () => void;
    const streaming = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    pi.stream.mockImplementation(async function* () { entered(); await delayed; yield done; });
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
    const { config, store, pi, testModel } = await setup();
    vi.useFakeTimers();
    store.get = () => new Promise(() => {});
    const pending = testModel(config.id);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(pi.stream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a pre-aborted test and clears timers after success', async () => {
    const { config, pi, testModel } = await setup();
    vi.useFakeTimers();
    await expect(testModel(config.id, AbortSignal.abort())).rejects.toMatchObject({ code: 'RUN_STOPPED' });
    expect(pi.resolve).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(testModel(config.id)).resolves.toMatchObject({ connected: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
