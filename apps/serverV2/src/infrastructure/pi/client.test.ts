import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, AssistantMessageEvent, Context, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { PiClient, providerErrorCode, type PiEvent, type PiMessage, type PiModel, type PiSdk } from './client.js';

function model(overrides: Partial<PiModel> = {}): PiModel {
  return {
    id: 'story', name: 'Story', api: 'openai-completions', provider: 'test', baseUrl: 'https://example.invalid',
    reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 4096,
    compat: { supportsMidConvoSystemMessages: true },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...overrides,
  };
}
function message(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant', api: 'openai-completions', provider: 'test', model: 'story', timestamp: 1,
    content: [{ type: 'text', text }], stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  };
}
function sdk(stream: PiSdk['streamSimple'], definitions = [model()]): PiSdk {
  return {
    getProviders: () => [...new Set(definitions.map(value => value.provider))].map(id => ({ id })),
    getModels: provider => definitions.filter(value => !provider || value.provider === provider),
    getModel: (provider, id) => definitions.find(value => value.provider === provider && value.id === id),
    streamSimple: stream,
  };
}
function finite(events: AssistantMessageEvent[]): PiSdk['streamSimple'] {
  return async function* () { for (const event of events) yield event; };
}
async function collect(events: AsyncIterable<PiEvent>): Promise<PiEvent[]> {
  const result: PiEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function options(controller = new AbortController()) {
  return { apiKey: 'secret-test-key', signal: controller.signal, maxTokens: 512, temperature: 0.7, thinkingEnabled: true };
}
const input: PiMessage[] = [{ role: 'user', content: 'hello', timestamp: 1 }];

describe('PiClient SDK boundary', () => {
  it('makes one explicit-key request, preserves message roles/order and exposes text plus a safe terminal', async () => {
    let captured: { context: Context; options: SimpleStreamOptions } | undefined;
    const output = message('hello world', { usage: {
      input: 8, output: 7, cacheRead: 12, cacheWrite: 3, reasoning: 4, totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } });
    const stream = vi.fn((selected: PiModel, context: Context, request: SimpleStreamOptions) => {
      captured = { context, options: request };
      return finite([
        { type: 'thinking_delta', contentIndex: 1, delta: 'private reasoning', partial: output },
        { type: 'text_delta', contentIndex: 0, delta: 'hello ', partial: output },
        { type: 'text_delta', contentIndex: 0, delta: 'world', partial: output },
        { type: 'done', reason: 'stop', message: output },
      ])(selected, context, request);
    });
    const client = new PiClient(sdk(stream));
    const messages: PiMessage[] = [
      { role: 'system', content: 'base' }, { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old answer' }, { role: 'system', content: 'current' }, ...input,
    ];
    const result = await collect(client.stream(model(), messages, options()));
    expect(stream).toHaveBeenCalledTimes(1);
    expect(captured?.context.messages.map(value => value.role)).toEqual(messages.map(value => value.role));
    expect(captured?.context.tools).toBeUndefined();
    expect(captured?.options).toMatchObject({
      apiKey: 'secret-test-key', maxRetries: 0, maxTokens: 512, temperature: 0.7, reasoning: 'medium',
    });
    expect(result).toEqual([
      { type: 'text_delta', delta: 'hello ' }, { type: 'text_delta', delta: 'world' },
      { type: 'done', text: 'hello world', stopReason: 'stop', hasToolCalls: false,
        usage: { inputTokens: 23, outputTokens: 7, totalTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 3 } },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-test-key');
    expect(JSON.stringify(result)).not.toContain('private reasoning');
  });

  it('passes done-only output and abnormal finish reasons to the usecase without inventing deltas', async () => {
    const output = message('partial', { stopReason: 'length' });
    const result = await collect(new PiClient(sdk(finite([{ type: 'done', reason: 'length', message: output }]))).stream(model(), input, options()));
    expect(result).toEqual([{ type: 'done', text: 'partial', stopReason: 'length', hasToolCalls: false, usage: null }]);
    const tool = message('', { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't', name: 'unexpected', arguments: {} }] });
    const withTool = await collect(new PiClient(sdk(finite([{ type: 'done', reason: 'toolUse', message: tool }]))).stream(model(), input, options()));
    expect(withTool[0]).toMatchObject({ type: 'done', stopReason: 'toolUse', hasToolCalls: true });
  });

  it('does not turn an exhausted stream into a successful terminal', async () => {
    const partial = message('unfinished');
    const result = await collect(new PiClient(sdk(finite([
      { type: 'text_delta', contentIndex: 0, delta: 'unfinished', partial },
    ]))).stream(model(), input, options()));
    expect(result).toEqual([{ type: 'text_delta', delta: 'unfinished' }]);
  });

  it('keeps emitted text on iterator exceptions, with no raw provider error or key leakage', async () => {
    const result = await collect(new PiClient(sdk(async function* () {
      yield { type: 'text_delta', contentIndex: 0, delta: 'saved fragment', partial: message('saved fragment') };
      throw new Error('request Authorization=secret-test-key failed at /private/path');
    })).stream(model(), input, options()));
    expect(result).toEqual([
      { type: 'text_delta', delta: 'saved fragment' },
      { type: 'error', errorCode: 'PROVIDER_ERROR', text: 'saved fragment', usage: null },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-test-key');
    expect(JSON.stringify(result)).not.toContain('/private/path');
  });

  it('returns SDK error partial text when no text delta arrived, and recognizes structured overflow', async () => {
    const output = message('provider partial', { stopReason: 'error',
      errorMessage: '400: {"error":{"code":"context_length_exceeded","message":"secret-test-key"}}' });
    const result = await collect(new PiClient(sdk(finite([
      { type: 'error', reason: 'error', error: output },
    ]))).stream(model(), input, options()));
    expect(result).toEqual([{ type: 'error', errorCode: 'PROVIDER_CONTEXT_WINDOW_EXCEEDED', text: 'provider partial', usage: null }]);
    expect(providerErrorCode({ errorMessage: 'context length exceeded, secret-test-key' })).toBe('PROVIDER_ERROR');
    const cyclic: Record<string, unknown> = {};
    cyclic.error = cyclic;
    expect(providerErrorCode(cyclic)).toBe('PROVIDER_ERROR');
  });

  it('uses input usage evidence from the provider hook to distinguish real zero counters from SDK defaults', async () => {
    const output = message('OK');
    const reported = new PiClient(sdk(async function* (selected, _context, request) {
      await request.onProviderStreamEvent?.({ usage: { prompt_tokens: 0, completion_tokens: 0 } }, selected);
      yield { type: 'done', reason: 'stop', message: output };
    }));
    const result = await collect(reported.stream(model(), input, options()));
    expect(result[0]).toMatchObject({ type: 'done', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
    const defaults = new PiClient(sdk(finite([{ type: 'done', reason: 'stop', message: output }])));
    expect((await collect(defaults.stream(model(), input, options())))[0]).toMatchObject({ usage: null });
  });

  it('uses structured errors observed in raw provider events without exposing those events', async () => {
    const client = new PiClient(sdk(async function* (selected, _context, request) {
      await request.onProviderStreamEvent?.({ error: { code: 'context_window_exceeded', message: 'secret-test-key' } }, selected);
      yield { type: 'error', reason: 'error', error: message('', { stopReason: 'error', errorMessage: 'provider failure' }) };
    }));
    const events = await collect(client.stream(model(), input, options()));
    expect(events).toEqual([{ type: 'error', errorCode: 'PROVIDER_CONTEXT_WINDOW_EXCEEDED', text: '', usage: null }]);
  });

  it('cancels a pending next and ignores late output without awaiting a non-cooperative iterator return', async () => {
    const controller = new AbortController();
    let resolveNext!: (value: IteratorResult<AssistantMessageEvent>) => void;
    const cleanup = vi.fn(() => new Promise<IteratorResult<AssistantMessageEvent>>(() => {}));
    const stream: AsyncIterable<AssistantMessageEvent> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(resolve => { resolveNext = resolve; }), return: cleanup }),
    };
    const client = new PiClient(sdk(() => stream));
    const iterator = client.stream(model(), input, options(controller))[Symbol.asyncIterator]();
    const next = iterator.next();
    controller.abort();
    await expect(next).resolves.toEqual({ done: false, value: { type: 'error', errorCode: 'RUN_STOPPED', text: '', usage: null } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(cleanup).toHaveBeenCalledTimes(1);
    resolveNext({ done: false, value: { type: 'done', reason: 'stop', message: message('too late') } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('retains already emitted text on stop, and does not invoke SDK if already stopped or credential is empty', async () => {
    const controller = new AbortController();
    let resumedAfterDelta = false;
    const stream = vi.fn(async function* () {
      yield { type: 'text_delta' as const, contentIndex: 0, delta: 'before stop', partial: message('before stop') };
      resumedAfterDelta = true;
      await new Promise(() => {});
    });
    const client = new PiClient(sdk(stream));
    const iterator = client.stream(model(), input, options(controller))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'text_delta', delta: 'before stop' });
    controller.abort();
    expect((await iterator.next()).value).toEqual({ type: 'error', errorCode: 'RUN_STOPPED', text: 'before stop', usage: null });
    await iterator.next();
    expect(resumedAfterDelta).toBe(false);
    stream.mockClear();
    expect(await collect(client.stream(model(), input, options(controller)))).toEqual([
      { type: 'error', errorCode: 'RUN_STOPPED', text: '', usage: null },
    ]);
    expect(stream).not.toHaveBeenCalled();
    await expect(collect(client.stream(model(), input, { ...options(), apiKey: ' ' }))).rejects.toMatchObject({ code: 'CREDENTIAL_NOT_CONFIGURED' });
    expect(stream).not.toHaveBeenCalled();
  });

  it('rejects unverified mid-conversation system messages before any provider request', async () => {
    const stream = vi.fn(finite([]));
    const client = new PiClient(sdk(stream));
    const unsupported = model({ compat: {} });
    const messages: PiMessage[] = [{ role: 'user', content: 'history' }, { role: 'system', content: 'later' }];
    await expect(collect(client.stream(unsupported, messages, options()))).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_UNSUPPORTED' });
    expect(stream).not.toHaveBeenCalled();
    expect(() => client.assertMessageOrder(unsupported, [{ role: 'system', content: 'first' }, ...input])).not.toThrow();
    expect(() => client.assertMessageOrder(model({ api: 'openai-responses' }), messages)).toThrow('MODEL_CAPABILITY_UNSUPPORTED');
  });

  it('lists safe catalog fields and scopes the DeepSeek flag correction to the original verified endpoint and model', () => {
    const flash = model({ provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash',
      baseUrl: 'https://api.deepseek.com', compat: {}, headers: { Authorization: 'secret-test-key' } });
    const variants = [
      model({ ...flash, id: 'other' }),
      model({ ...flash, provider: 'proxy' }),
      model({ ...flash, name: 'DeepSeek V3 Flash' }),
      model({ ...flash, baseUrl: 'https://api.deepseek.com.example.invalid' }),
      model({ ...flash, api: 'openai-responses' }),
    ];
    const client = new PiClient(sdk(finite([]), [flash]));
    const resolved = client.resolve('deepseek', 'deepseek-flash');
    expect(resolved.compat).toMatchObject({ supportsMidConvoSystemMessages: true });
    expect(flash.compat).toEqual({});
    expect(client.listModels()).toEqual([{
      providerId: 'deepseek', modelId: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 32000,
      maxTokens: 4096, reasoning: true, narrativeCompatible: true, supportsMidConversationSystemMessages: true,
    }]);
    expect(JSON.stringify(client.listModels())).not.toContain('secret-test-key');
    expect(() => client.resolve('deepseek', 'missing')).toThrow('MODEL_NOT_FOUND');
    for (const variant of variants) {
      const other = new PiClient(sdk(finite([]), [variant]));
      expect(other.listModels()[0]?.narrativeCompatible).toBe(false);
    }
  });
});
