import { describe, expect, it, vi } from 'vitest';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions, ToolCall } from '@earendil-works/pi-ai';
import type { ModelEvent, ModelInfo, ModelMessage, ModelSnapshot } from '../model/client.js';
import { PiClient, providerErrorCode, type PiSdk } from './client.js';

type SdkModel = Model<Api>;
function model(overrides: Partial<SdkModel> = {}): SdkModel {
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
    getProviders: () => [...new Set(definitions.map(value => value.provider))].map(id => ({ id, name: id + ' Models' })),
    getModels: provider => definitions.filter(value => !provider || value.provider === provider),
    getModel: (provider, id) => definitions.find(value => value.provider === provider && value.id === id),
    streamSimple: stream,
  };
}
function finite(events: AssistantMessageEvent[]): PiSdk['streamSimple'] {
  return async function* () { for (const event of events) yield event; };
}
async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function options(controller = new AbortController()) {
  return { apiKey: 'secret-test-key', signal: controller.signal, maxTokens: 512, temperature: 0.7, thinkingEnabled: true };
}
function selected(client: PiClient): ModelInfo { return client.resolve('test', 'story'); }
function snapshot(content = '', reasoning_content = '', tool_calls: ModelSnapshot['tool_calls'] = []): ModelSnapshot {
  return { role: 'assistant', content, reasoning_content, tool_calls };
}
const input: ModelMessage[] = [{ role: 'user', content: 'hello', timestamp: 1 }];
const started: ModelEvent = { type: 'request_started' };

describe('PiClient SDK boundary', () => {
  it('makes one explicit-key request, keeps ordered roles, and exposes public reasoning/text with a safe snapshot', async () => {
    let captured: { context: Context; options: SimpleStreamOptions } | undefined;
    const output = message('hello world', {
      content: [{ type: 'thinking', thinking: 'public reasoning', thinkingSignature: 'private-signature' },
        { type: 'text', text: 'hello world', textSignature: 'private-text-signature' }],
      usage: { input: 8, output: 7, cacheRead: 12, cacheWrite: 3, reasoning: 4, totalTokens: 30,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const stream = vi.fn((definition: SdkModel, context: Context, request: SimpleStreamOptions) => {
      captured = { context, options: request };
      return finite([
        { type: 'thinking_delta', contentIndex: 0, delta: 'public reasoning', partial: output },
        { type: 'text_delta', contentIndex: 1, delta: 'hello ', partial: output },
        { type: 'text_delta', contentIndex: 1, delta: 'world', partial: output },
        { type: 'done', reason: 'stop', message: output },
      ])(definition, context, request);
    });
    const client = new PiClient(sdk(stream));
    const messages: ModelMessage[] = [
      { role: 'system', content: 'base' }, { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old answer' }, { role: 'system', content: 'current' }, ...input,
    ];
    const result = await collect(client.stream(selected(client), messages, options()));
    expect(stream).toHaveBeenCalledTimes(1);
    expect(captured?.context.messages.map(value => value.role)).toEqual(messages.map(value => value.role));
    expect(captured?.context.tools).toBeUndefined();
    expect(captured?.options).toMatchObject({
      apiKey: 'secret-test-key', maxRetries: 0, maxTokens: 512, temperature: 0.7, reasoning: 'medium',
    });
    expect(result).toEqual([
      started,
      { type: 'delta', delta: { reasoning_content: 'public reasoning' } },
      { type: 'delta', delta: { content: 'hello ' } }, { type: 'delta', delta: { content: 'world' } },
      { type: 'done', snapshot: snapshot('hello world', 'public reasoning'), finishReason: 'stop',
        usage: { inputTokens: 23, outputTokens: 7, totalTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 3 } },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret-test-key|private-signature|private-text-signature/);
  });

  it('normalizes done-only text, tool calls and finish reasons without inventing append deltas', async () => {
    const output = message('partial', { stopReason: 'length' });
    const client = new PiClient(sdk(finite([{ type: 'done', reason: 'length', message: output }])));
    expect(await collect(client.stream(selected(client), input, options()))).toEqual([
      started, { type: 'done', snapshot: snapshot('partial'), finishReason: 'length', usage: null },
    ]);
    const tool = message('', { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 't', name: 'lookup', arguments: {} }] });
    const tools = new PiClient(sdk(finite([{ type: 'done', reason: 'toolUse', message: tool }])));
    expect((await collect(tools.stream(selected(tools), input, options()))).at(-1)).toEqual({
      type: 'done', finishReason: 'tool_calls', usage: null,
      snapshot: snapshot('', '', [{ index: 0, id: 't', type: 'function', function: { name: 'lookup', arguments: '{}' } }]),
    });
    const deferred = new PiClient(sdk(finite([{ type: 'done', reason: 'deferred', message: message('', { stopReason: 'deferred' }) }])));
    expect((await collect(deferred.stream(selected(deferred), input, options()))).at(-1)).toMatchObject({ finishReason: 'deferred' });
  });

  it('turns missing SDK termination into an incomplete error retaining already received content', async () => {
    const partial = message('unfinished');
    const client = new PiClient(sdk(finite([{ type: 'text_delta', contentIndex: 0, delta: 'unfinished', partial }])));
    expect(await collect(client.stream(selected(client), input, options()))).toEqual([
      started, { type: 'delta', delta: { content: 'unfinished' } },
      { type: 'error', snapshot: snapshot('unfinished'), stopReason: 'incomplete_output', usage: null },
    ]);
  });

  it('keeps all observed partial fields on iterator failure without exposing raw errors or signatures', async () => {
    const call: ToolCall = { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {}, thoughtSignature: 'secret-signature' };
    const partial = message('', { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '' }, call] });
    const client = new PiClient(sdk(async function* () {
      yield { type: 'thinking_delta', contentIndex: 0, delta: 'reason', partial };
      yield { type: 'text_delta', contentIndex: 1, delta: 'fragment', partial };
      yield { type: 'toolcall_start', contentIndex: 2, partial };
      yield { type: 'toolcall_delta', contentIndex: 2, delta: '{"city":', partial };
      throw new Error('Authorization=secret-test-key failed at /private/path');
    }));
    const result = await collect(client.stream(selected(client), input, options()));
    expect(result.at(-1)).toEqual({
      type: 'error', stopReason: 'provider_error', usage: null,
      snapshot: snapshot('fragment', 'reason', [{ index: 0, id: 'call-1', type: 'function',
        function: { name: 'lookup', arguments: '{"city":' } }]),
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-test-key|private\/path|secret-signature/);
  });

  it('returns SDK error snapshots even without deltas and recognizes only structured overflow', async () => {
    const output = message('provider partial', { stopReason: 'error',
      errorMessage: '400: {"error":{"code":"context_length_exceeded","message":"secret-test-key"}}' });
    const client = new PiClient(sdk(finite([{ type: 'error', reason: 'error', error: output }])));
    expect(await collect(client.stream(selected(client), input, options()))).toEqual([
      started, { type: 'error', stopReason: 'context_window_exceeded', snapshot: snapshot('provider partial'), usage: null },
    ]);
    expect(providerErrorCode({ errorMessage: 'context length exceeded, secret-test-key' })).toBe('PROVIDER_ERROR');
    const cyclic: Record<string, unknown> = {};
    cyclic.error = cyclic;
    expect(providerErrorCode(cyclic)).toBe('PROVIDER_ERROR');
  });

  it('preserves observed content when an SDK error omits or truncates its partial response', async () => {
    const client = new PiClient(sdk(finite([
      { type: 'text_delta', contentIndex: 0, delta: 'complete fragment', partial: message('') },
      { type: 'thinking_delta', contentIndex: 1, delta: 'observed reason', partial: message('') },
      { type: 'error', reason: 'error', error: message('complete', { stopReason: 'error' }) },
    ])));
    expect((await collect(client.stream(selected(client), input, options()))).at(-1)).toMatchObject({
      snapshot: snapshot('complete fragment', 'observed reason'),
    });
  });

  it('distinguishes provider-reported zero usage from SDK default counters', async () => {
    const output = message('OK');
    const reported = new PiClient(sdk(async function* (definition, _context, request) {
      await request.onProviderStreamEvent?.({ usage: { prompt_tokens: 0, completion_tokens: 0 } }, definition);
      yield { type: 'done', reason: 'stop', message: output };
    }));
    expect((await collect(reported.stream(selected(reported), input, options()))).at(-1)).toMatchObject({
      type: 'done', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    const defaults = new PiClient(sdk(finite([{ type: 'done', reason: 'stop', message: output }])));
    expect((await collect(defaults.stream(selected(defaults), input, options()))).at(-1)).toMatchObject({ usage: null });
  });

  it('uses structured raw provider error codes without exposing raw events', async () => {
    const client = new PiClient(sdk(async function* (definition, _context, request) {
      await request.onProviderStreamEvent?.({ error: { code: 'context_window_exceeded', message: 'secret-test-key' } }, definition);
      yield { type: 'error', reason: 'error', error: message('', { stopReason: 'error', errorMessage: 'provider failure' }) };
    }));
    expect(await collect(client.stream(selected(client), input, options()))).toEqual([
      started, { type: 'error', stopReason: 'context_window_exceeded', snapshot: snapshot(), usage: null },
    ]);
  });

  it('announces synchronous SDK attempts once, including throws, before their terminal result', async () => {
    const stream = vi.fn(() => { throw new Error('secret-test-key'); });
    const client = new PiClient(sdk(stream));
    expect(await collect(client.stream(selected(client), input, options()))).toEqual([
      started, { type: 'error', stopReason: 'provider_error', snapshot: snapshot(), usage: null },
    ]);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('cancels pending next and ignores late output without waiting for uncooperative cleanup', async () => {
    const controller = new AbortController();
    let resolveNext!: (value: IteratorResult<AssistantMessageEvent>) => void;
    const cleanup = vi.fn(() => new Promise<IteratorResult<AssistantMessageEvent>>(() => {}));
    const source: AsyncIterable<AssistantMessageEvent> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(resolve => { resolveNext = resolve; }), return: cleanup }),
    };
    const client = new PiClient(sdk(() => source));
    const iterator = client.stream(selected(client), input, options(controller))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(started);
    const next = iterator.next();
    controller.abort();
    await expect(next).resolves.toEqual({ done: false, value: {
      type: 'error', stopReason: 'aborted', snapshot: snapshot(), usage: null,
    } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(cleanup).toHaveBeenCalledTimes(1);
    resolveNext({ done: false, value: { type: 'done', reason: 'stop', message: message('too late') } });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('retains received text on stop, never resumes the provider after abort, and never invokes an already stopped request', async () => {
    const controller = new AbortController();
    let resumed = false;
    const stream = vi.fn(async function* () {
      yield { type: 'text_delta' as const, contentIndex: 0, delta: 'before stop', partial: message('before stop') };
      resumed = true;
      await new Promise(() => {});
    });
    const client = new PiClient(sdk(stream));
    const iterator = client.stream(selected(client), input, options(controller))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(started);
    expect((await iterator.next()).value).toEqual({ type: 'delta', delta: { content: 'before stop' } });
    controller.abort();
    expect((await iterator.next()).value).toEqual({
      type: 'error', stopReason: 'aborted', snapshot: snapshot('before stop'), usage: null,
    });
    await iterator.next();
    expect(resumed).toBe(false);
    stream.mockClear();
    expect(await collect(client.stream(selected(client), input, options(controller)))).toEqual([
      { type: 'error', stopReason: 'aborted', snapshot: snapshot(), usage: null },
    ]);
    expect(stream).not.toHaveBeenCalled();
    await expect(collect(client.stream(selected(client), input, { ...options(), apiKey: ' ' }))).rejects.toMatchObject({
      code: 'CREDENTIAL_NOT_CONFIGURED',
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it('announces actual SDK invocation before yielding even when that invocation synchronously aborts', async () => {
    const controller = new AbortController();
    const next = vi.fn(async () => ({ done: true as const, value: undefined }));
    const stream = vi.fn(() => {
      controller.abort();
      return { [Symbol.asyncIterator]: () => ({ next }) };
    });
    const client = new PiClient(sdk(stream));
    const iterator = client.stream(selected(client), input, options(controller));
    expect((await iterator.next()).value).toEqual(started);
    expect(stream).toHaveBeenCalledTimes(1);
    expect((await iterator.next()).value).toMatchObject({ type: 'error', stopReason: 'aborted' });
    await iterator.next();
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects unsupported message order and budgets using internal SDK capabilities, not caller-mutable metadata', async () => {
    const stream = vi.fn(finite([]));
    const client = new PiClient(sdk(stream, [model({ compat: {} })]));
    const resolved = selected(client);
    const messages: ModelMessage[] = [{ role: 'user', content: 'history' }, { role: 'system', content: 'later' }];
    expect(() => client.assertMessageOrder(resolved, messages)).toThrow('MODEL_CAPABILITY_UNSUPPORTED');
    expect(() => client.assertMessageOrder(resolved, [{ role: 'system', content: 'first' }, ...input])).not.toThrow();
    resolved.supportsMidConversationSystemMessages = true;
    resolved.maxTokens = 100000;
    await expect(collect(client.stream(resolved, messages, options()))).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_UNSUPPORTED' });
    await expect(collect(client.stream(resolved, input, { ...options(), maxTokens: 5000 }))).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_UNSUPPORTED' });
    expect(stream).not.toHaveBeenCalled();
  });

  it('keeps tool indices separate from content indices and fills late IDs/names without appending identity strings', async () => {
    const a: ToolCall = { type: 'toolCall', id: '', name: '', arguments: {} };
    const b: ToolCall = { type: 'toolCall', id: 'b', name: 'second', arguments: {} };
    const output = message('', { content: [{ type: 'thinking', thinking: 'R' }, { type: 'text', text: 'T' }, a, b], stopReason: 'toolUse' });
    const client = new PiClient(sdk(async function* () {
      yield { type: 'toolcall_start', contentIndex: 2, partial: output };
      yield { type: 'toolcall_start', contentIndex: 3, partial: output };
      a.id = 'a'; a.name = 'first';
      yield { type: 'toolcall_delta', contentIndex: 2, delta: '{"x":', partial: output };
      yield { type: 'toolcall_delta', contentIndex: 3, delta: '{"y":2}', partial: output };
      a.arguments = { x: 1 }; b.arguments = { y: 2 };
      yield { type: 'toolcall_delta', contentIndex: 2, delta: '1}', partial: output };
      yield { type: 'toolcall_end', contentIndex: 2, toolCall: a, partial: output };
      yield { type: 'toolcall_end', contentIndex: 3, toolCall: b, partial: output };
      yield { type: 'done', reason: 'toolUse', message: output };
    }));
    const result = await collect(client.stream(selected(client), input, options()));
    expect(result[1]).toEqual({ type: 'delta', delta: { tool_calls: [{ index: 0, type: 'function' }] } });
    expect(result[3]).toEqual({ type: 'delta', delta: { tool_calls: [{
      index: 0, type: 'function', id: 'a', function: { name: 'first', arguments: '{"x":' },
    }] } });
    expect(result.at(-1)).toMatchObject({ snapshot: snapshot('T', 'R', [
      { index: 0, id: 'a', type: 'function', function: { name: 'first', arguments: '{"x":1}' } },
      { index: 1, id: 'b', type: 'function', function: { name: 'second', arguments: '{"y":2}' } },
    ]) });
  });

  it('replaces initial tool arguments and final text/reasoning with authoritative end snapshots', async () => {
    const call: ToolCall = { type: 'toolCall', id: 'a', name: 'lookup', arguments: { city: 'Paris' } };
    const output = message('draft', { content: [
      { type: 'thinking', thinking: 'draft reason', thinkingSignature: 'secret-signature' },
      { type: 'text', text: 'draft' }, call,
    ], stopReason: 'toolUse' });
    const client = new PiClient(sdk(async function* () {
      yield { type: 'thinking_start', contentIndex: 0, partial: output };
      yield { type: 'thinking_delta', contentIndex: 0, delta: 'draft reason', partial: output };
      yield { type: 'text_start', contentIndex: 1, partial: output };
      yield { type: 'text_delta', contentIndex: 1, delta: 'draft', partial: output };
      yield { type: 'toolcall_start', contentIndex: 2, partial: output };
      call.arguments = { city: 'London' };
      output.content[0] = { type: 'thinking', thinking: 'final reason', thinkingSignature: 'secret-final-signature' };
      output.content[1] = { type: 'text', text: 'final body' };
      yield { type: 'thinking_end', contentIndex: 0, content: 'final reason', partial: output };
      yield { type: 'text_end', contentIndex: 1, content: 'final body', partial: output };
      yield { type: 'toolcall_end', contentIndex: 2, toolCall: call, partial: output };
      yield { type: 'done', reason: 'toolUse', message: output };
    }));
    const result = await collect(client.stream(selected(client), input, options()));
    expect(result.at(-1)).toMatchObject({ snapshot: snapshot('final body', 'final reason', [
      { index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"city":"London"}' } },
    ]) });
    expect(result.filter(event => event.type === 'delta' && event.delta.content)).toEqual([
      { type: 'delta', delta: { content: 'draft' } },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps initial tool arguments on SDK failure and rejects malformed final arguments safely', async () => {
    const initial: ToolCall = { type: 'toolCall', id: 'a', name: 'lookup', arguments: { city: 'Paris' } };
    const partial = message('', { content: [initial] });
    const fail = new PiClient(sdk(async function* () {
      yield { type: 'toolcall_start', contentIndex: 0, partial };
      throw new Error('provider down');
    }));
    expect((await collect(fail.stream(selected(fail), input, options()))).at(-1)).toMatchObject({
      snapshot: snapshot('', '', [{ index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"city":"Paris"}' } }]),
    });
    const malformed: ToolCall = { type: 'toolCall', id: 'b', name: 'lookup', arguments: {}, argumentsError: 'secret-test-key invalid raw metadata' };
    const invalid = message('', { content: [malformed], stopReason: 'toolUse' });
    const client = new PiClient(sdk(finite([
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"bad":', partial: invalid },
      { type: 'done', reason: 'toolUse', message: invalid },
    ])));
    const events = await collect(client.stream(selected(client), input, options()));
    expect(events.at(-1)).toMatchObject({
      type: 'error', stopReason: 'invalid_output',
      snapshot: snapshot('', '', [{ index: 0, id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"bad":' } }]),
    });
    expect(JSON.stringify(events)).not.toContain('secret-test-key');
  });

  it('does not let a live partial advanced ahead of queued events enter an iterator-failure snapshot', async () => {
    const call: ToolCall = { type: 'toolCall', id: 'a', name: 'lookup', arguments: {} };
    const partial = message('', { content: [call] });
    const queued: AssistantMessageEvent[] = [
      { type: 'toolcall_start', contentIndex: 0, partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"consumed":', partial },
    ];
    // The SDK queues references, then mutates their shared partial before the consumer reads them.
    call.arguments = { future: 'not-delivered' };
    const client = new PiClient(sdk(async function* () {
      yield* queued;
      throw new Error('stream interrupted');
    }));
    const events = await collect(client.stream(selected(client), input, options()));
    expect(events.at(-1)).toMatchObject({
      type: 'error', stopReason: 'provider_error',
      snapshot: snapshot('', '', [{ index: 0, id: 'a', type: 'function',
        function: { name: 'lookup', arguments: '{"consumed":' } }]),
    });
    expect(JSON.stringify(events)).not.toContain('not-delivered');
  });

  it('detaches public deltas and final snapshots from shared mutable SDK objects', async () => {
    const call: ToolCall = { type: 'toolCall', id: 'a', name: 'lookup', arguments: { value: 1 } };
    const output = message('old', { content: [{ type: 'text', text: 'old' }, call], stopReason: 'toolUse' });
    const client = new PiClient(sdk(finite([
      { type: 'toolcall_start', contentIndex: 1, partial: output },
      { type: 'done', reason: 'toolUse', message: output },
    ])));
    const iterator = client.stream(selected(client), input, options());
    await iterator.next();
    const delta = (await iterator.next()).value;
    const terminal = (await iterator.next()).value;
    call.id = 'late'; call.name = 'late'; call.arguments = { value: 2 };
    output.content[0] = { type: 'text', text: 'late' };
    expect(delta).toMatchObject({ delta: { tool_calls: [{ id: 'a', function: { name: 'lookup' } }] } });
    expect(terminal).toMatchObject({ snapshot: snapshot('old', '', [
      { index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"value":1}' } },
    ]) });
    await iterator.next();
  });

  it('translates owned tool-result inputs without executing tools or exporting SDK messages', async () => {
    let captured: Context | undefined;
    const client = new PiClient(sdk((definition, context, request) => {
      captured = context;
      return finite([{ type: 'done', reason: 'stop', message: message('OK') }])(definition, context, request);
    }));
    await collect(client.stream(selected(client), [
      ...input,
      { role: 'assistant', content: '', tool_calls: [
        { index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"value":1}' } },
      ] },
      { role: 'tool', tool_call_id: 'a', name: 'lookup', content: 'result', is_error: false },
    ], options()));
    expect(captured?.messages[1]).toMatchObject({ role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'a', name: 'lookup', arguments: { value: 1 } }] });
    expect(captured?.messages[2]).toMatchObject({ role: 'toolResult', toolCallId: 'a', toolName: 'lookup',
      content: [{ type: 'text', text: 'result' }], isError: false });
    expect(captured?.tools).toBeUndefined();
  });

  it('returns only safe model metadata and scopes the DeepSeek correction to the verified endpoint', () => {
    const flash = model({ provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash',
      baseUrl: 'https://api.deepseek.com', compat: {}, headers: { Authorization: 'secret-test-key' } });
    const client = new PiClient(sdk(finite([]), [flash]));
    const resolved = client.resolve('deepseek', 'deepseek-flash');
    expect(resolved).toMatchObject({ narrativeCompatible: true, supportsMidConversationSystemMessages: true });
    expect(flash.compat).toEqual({});
    expect(resolved).not.toHaveProperty('compat');
    expect(resolved).not.toHaveProperty('baseUrl');
    expect(resolved).not.toHaveProperty('headers');
    expect(JSON.stringify(resolved)).not.toContain('secret-test-key');
    expect(() => client.resolve('deepseek', 'missing')).toThrow('MODEL_NOT_FOUND');
    for (const variant of [
      model({ ...flash, id: 'other' }), model({ ...flash, provider: 'proxy' }),
      model({ ...flash, name: 'DeepSeek V3 Flash' }), model({ ...flash, baseUrl: 'https://api.deepseek.com.example.invalid' }),
      model({ ...flash, api: 'openai-responses' }),
    ]) {
      const other = new PiClient(sdk(finite([]), [variant]));
      expect(other.listProviders()[0]?.models[0]?.narrativeCompatible).toBe(false);
    }
  });
});

describe('provider catalog metadata', () => {
  it('groups models by SDK provider name and identity without merging duplicate model IDs', () => {
    const definitions = [
      model({ provider: 'alpha', id: 'same', name: 'Alpha model', input: ['text', 'image'] }),
      model({ provider: 'beta', id: 'same', name: 'Beta model', api: 'openai-responses', reasoning: false }),
      model({ provider: 'alpha', id: 'other', name: 'Other Alpha model' }),
    ];
    const stream = vi.fn(finite([]));
    const source = sdk(stream, definitions);
    source.getProviders = () => [
      { id: 'beta', name: 'Beta Official' }, { id: 'alpha', name: 'Alpha Official' }, { id: 'dynamic', name: 'No static models' },
    ];
    const catalog = new PiClient(source).listProviders();
    expect(catalog.map(provider => [provider.providerId, provider.name, provider.models.map(item => item.modelId)])).toEqual([
      ['beta', 'Beta Official', ['same']], ['alpha', 'Alpha Official', ['same', 'other']],
    ]);
    expect(catalog[0]?.models[0]).toMatchObject({
      providerId: 'beta', api: 'openai-responses', input: ['text'], reasoning: false, thinkingLevels: ['off'],
    });
    expect(catalog[1]?.models[0]).toMatchObject({ providerId: 'alpha', input: ['text', 'image'] });
    expect(stream).not.toHaveBeenCalled();
  });

  it('preserves raw thinking mappings and uses the SDK effective supported-level calculation', () => {
    const mapped = model({ thinkingLevelMap: {
      off: null, minimal: null, low: 'light', medium: null, high: 'deep', max: 'maximum',
    } });
    const catalog = new PiClient(sdk(finite([]), [mapped])).listProviders();
    expect(catalog[0]?.models[0]).toMatchObject({
      thinkingLevels: ['low', 'high', 'max'],
      thinkingLevelMap: { off: null, minimal: null, low: 'light', medium: null, high: 'deep', max: 'maximum' },
    });
    expect(catalog[0]?.models[0]?.thinkingLevelMap).not.toHaveProperty('xhigh');
  });

  it('returns prompt-cache lifetimes only when the model supplies them, keeping missing tiers explicitly unknown', () => {
    const catalog = new PiClient(sdk(finite([]), [
      model({ id: 'known', promptCache: { short: 300, long: 3600 } }),
      model({ id: 'partial', promptCache: { short: 60 } }),
      model({ id: 'unknown', compat: { supportsLongCacheRetention: true } }),
    ])).listProviders();
    expect(catalog[0]?.models.map(value => value.promptCache)).toEqual([
      { short: 300, long: 3600 }, { short: 60, long: null }, null,
    ]);
  });

  it('returns independent allowlisted metadata rather than writable SDK objects or provider connection details', () => {
    const definition = model({ input: ['text', 'image'], thinkingLevelMap: { low: 'low' }, promptCache: { short: 300 },
      headers: { Authorization: 'secret-test-key' } });
    const client = new PiClient(sdk(finite([]), [definition]));
    const info = client.listProviders()[0]!.models[0]!;
    info.input.push('text');
    info.thinkingLevelMap!.low = null;
    info.promptCache!.short = 1;
    info.thinkingLevels.length = 0;
    expect(definition.input).toEqual(['text', 'image']);
    expect(definition.thinkingLevelMap).toEqual({ low: 'low' });
    expect(definition.promptCache).toEqual({ short: 300 });
    const serialized = JSON.stringify(client.listProviders());
    expect(serialized).not.toContain('secret-test-key');
    expect(serialized).not.toContain('baseUrl');
    expect(serialized).not.toContain('headers');
    expect(serialized).not.toContain('cost');
  });
});
