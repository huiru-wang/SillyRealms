import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/models';
import type {
  Api, AssistantMessageEvent, Context, Message, Model, SimpleStreamOptions, ToolCall,
} from '@earendil-works/pi-ai';
import { AppError, type ErrorCode } from '../../errors.js';
import type {
  ModelClient, ModelEvent, ModelFinishReason, ModelInfo, ModelMessage, ModelOptions,
  ModelStopReason, ModelThinkingLevel, ModelThinkingLevelMap, ProviderInfo,
} from '../model/client.js';
import { emitModelDiagnostic } from '../model/diagnostics.js';
import { PiContent } from './stream-content.js';
import { hasInputUsageReport, normalizeUsage } from './usage.js';

type SdkModel = Model<Api>;
const thinkingLevelNames: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** Adapter-local SDK seam for finite iterator tests. Application callers use ModelClient. */
export type PiSdk = {
  getProviders(): readonly { id: string; name: string }[];
  getModels(provider?: string): readonly SdkModel[];
  getModel(provider: string, id: string): SdkModel | undefined;
  streamSimple(model: SdkModel, context: Context, options: SimpleStreamOptions): AsyncIterable<AssistantMessageEvent>;
};

function supportsMidConversationSystemMessages(model: SdkModel): boolean {
  return model.api === 'openai-completions'
    && (model as Model<'openai-completions'>).compat?.supportsMidConvoSystemMessages === true;
}

/** Pi 1.5.0 omits this catalog flag only on the verified DeepSeek V4.1 Flash endpoint. */
function adaptModel(model: SdkModel): SdkModel {
  let deepSeekFlash = false;
  try {
    deepSeekFlash = model.api === 'openai-completions' && model.provider === 'deepseek'
      && model.id === 'deepseek-flash' && /V4\.1/.test(model.name)
      && new URL(model.baseUrl).hostname === 'api.deepseek.com';
  } catch { /* An invalid endpoint cannot receive a compatibility exception. */ }
  return deepSeekFlash ? { ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } } : model;
}

function modelInfo(model: SdkModel): ModelInfo {
  const ordered = supportsMidConversationSystemMessages(model);
  const thinkingLevelMap: ModelThinkingLevelMap | null = model.thinkingLevelMap === undefined ? null
    : Object.fromEntries(thinkingLevelNames.flatMap(level => {
      const value = model.thinkingLevelMap?.[level];
      return value === undefined ? [] : [[level, value]];
    }));
  return {
    providerId: model.provider, modelId: model.id, name: model.name,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, api: model.api, input: [...model.input],
    reasoning: model.reasoning, thinkingLevels: [...getSupportedThinkingLevels(model)], thinkingLevelMap,
    promptCache: model.promptCache === undefined ? null
      : { short: model.promptCache.short ?? null, long: model.promptCache.long ?? null },
    narrativeCompatible: ordered, supportsMidConversationSystemMessages: ordered,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

/** Classify structured codes only. Neither arbitrary provider prose nor credentials leave this boundary. */
export function providerErrorCode(error: unknown, depth = 0): ErrorCode {
  if (error instanceof AppError) return error.code;
  if (depth > 3) return 'PROVIDER_ERROR';
  const value = record(error);
  if (!value) return 'PROVIDER_ERROR';
  const nested = record(value.error);
  const candidates = [value.code, value.type, nested?.code, nested?.type, value.errorMessage];
  if (candidates.some(code => code === 'PROVIDER_CONTEXT_WINDOW_EXCEEDED'
    || code === 'context_length_exceeded' || code === 'context_window_exceeded')) {
    return 'PROVIDER_CONTEXT_WINDOW_EXCEEDED';
  }
  if (nested && providerErrorCode(nested, depth + 1) === 'PROVIDER_CONTEXT_WINDOW_EXCEEDED') {
    return 'PROVIDER_CONTEXT_WINDOW_EXCEEDED';
  }
  // Pi keeps some structured HTTP bodies in errorMessage as "400: {json}".
  if (typeof value.errorMessage === 'string') {
    const body = value.errorMessage.replace(/^[45]\d{2}:?\s+(?=\{)/u, '');
    try {
      if (providerErrorCode(JSON.parse(body), depth + 1) === 'PROVIDER_CONTEXT_WINDOW_EXCEEDED') {
        return 'PROVIDER_CONTEXT_WINDOW_EXCEEDED';
      }
    } catch { /* Never pass through untrusted error text. */ }
  }
  return 'PROVIDER_ERROR';
}

function modelStopReason(error: unknown): ModelStopReason {
  switch (providerErrorCode(error)) {
    case 'RUN_STOPPED': return 'aborted';
    case 'PROVIDER_CONTEXT_WINDOW_EXCEEDED': return 'context_window_exceeded';
    case 'MODEL_OUTPUT_INVALID': return 'invalid_output';
    case 'MODEL_OUTPUT_INCOMPLETE': return 'incomplete_output';
    default: return 'provider_error';
  }
}

function finishReason(reason: string): ModelFinishReason | undefined {
  if (reason === 'toolUse') return 'tool_calls';
  return reason === 'stop' || reason === 'length' || reason === 'deferred' ? reason : undefined;
}

function sdkContext(model: SdkModel, messages: readonly ModelMessage[]): Context {
  return {
    messages: messages.map((message): Message => {
      const timestamp = message.timestamp ?? 0;
      if (message.role === 'tool') return {
        role: 'toolResult', toolCallId: message.tool_call_id, toolName: message.name,
        content: [{ type: 'text', text: message.content }], isError: message.is_error ?? false, timestamp,
      };
      if (message.role !== 'assistant') return { role: message.role, content: message.content, timestamp };
      const tools: ToolCall[] = (message.tool_calls ?? []).map(call => {
        let args: unknown;
        try { args = JSON.parse(call.function.arguments); } catch { throw new AppError('MODEL_OUTPUT_INVALID'); }
        if (!args || typeof args !== 'object' || Array.isArray(args) || !call.id || !call.function.name) {
          throw new AppError('MODEL_OUTPUT_INVALID');
        }
        return { type: 'toolCall', id: call.id, name: call.function.name, arguments: args as ToolCall['arguments'] };
      });
      return {
        role: 'assistant',
        content: [
          ...(message.reasoning_content ? [{ type: 'thinking' as const, thinking: message.reasoning_content }] : []),
          ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
          ...tools,
        ],
        api: model.api, provider: model.provider, model: model.id, timestamp, stopReason: tools.length ? 'toolUse' : 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
    }),
  };
}

export class PiClient implements ModelClient {
  constructor(private readonly sdk: PiSdk = builtinModels()) {}

  private sdkModel(providerId: string, modelId: string): SdkModel {
    const model = this.sdk.getModel(providerId, modelId);
    if (!model) throw new AppError('MODEL_NOT_FOUND');
    return adaptModel(model);
  }

  listProviders(): ProviderInfo[] {
    return this.sdk.getProviders().map(provider => ({
      providerId: provider.id, name: provider.name,
      models: this.sdk.getModels(provider.id).map(model => modelInfo(adaptModel(model))),
    })).filter(provider => provider.models.length > 0);
  }

  resolve(providerId: string, modelId: string): ModelInfo {
    return modelInfo(this.sdkModel(providerId, modelId));
  }

  assertMessageOrder(model: ModelInfo, messages: readonly ModelMessage[]): void {
    let conversationStarted = false;
    for (const message of messages) {
      if (message.role !== 'system') conversationStarted = true;
      else if (conversationStarted && !model.supportsMidConversationSystemMessages) {
        throw new AppError('MODEL_CAPABILITY_UNSUPPORTED');
      }
    }
  }

  /** One SDK request. Cancellation releases the consumer even if the provider ignores its signal. */
  async *stream(model: ModelInfo, messages: readonly ModelMessage[], options: ModelOptions): AsyncGenerator<ModelEvent> {
    if (!options.apiKey?.trim()) throw new AppError('CREDENTIAL_NOT_CONFIGURED');
    const selected = this.sdkModel(model.providerId, model.modelId);
    this.assertMessageOrder(modelInfo(selected), messages);
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0 || options.maxTokens > selected.maxTokens) {
      throw new AppError('MODEL_CAPABILITY_UNSUPPORTED');
    }
    const context = sdkContext(selected, messages);
    const content = new PiContent();
    let reported = false;
    let providerFailure: ModelStopReason | undefined;
    let attempted = false, announced = false, observing = true;
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
    const marker = Symbol('aborted');
    let cancel!: () => void;
    const aborted = new Promise<typeof marker>(resolve => { cancel = () => resolve(marker); });
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    try {
      if (options.signal.aborted) throw new AppError('RUN_STOPPED');
      attempted = true;
      iterator = this.sdk.streamSimple(selected, context, {
        apiKey: options.apiKey, signal: options.signal, maxTokens: options.maxTokens,
        temperature: options.temperature,
        reasoning: options.thinkingEnabled && selected.reasoning ? 'medium' : undefined,
        maxRetries: 0,
        onPayload: payload => {
          if (observing && !options.signal.aborted) {
            emitModelDiagnostic(options, { type: 'request', source: 'provider_payload', data: payload });
          }
          // Returning a value replaces the SDK request; diagnostics must never do so.
          return undefined;
        },
        onProviderStreamEvent: raw => {
          reported ||= hasInputUsageReport(raw);
          if (providerErrorCode(raw) === 'PROVIDER_CONTEXT_WINDOW_EXCEEDED') providerFailure = 'context_window_exceeded';
        },
      })[Symbol.asyncIterator]();
      announced = true;
      yield { type: 'request_started' };

      while (true) {
        if (options.signal.aborted) throw new AppError('RUN_STOPPED');
        const next = await Promise.race([iterator.next(), aborted]);
        if (next === marker || options.signal.aborted) throw new AppError('RUN_STOPPED');
        if (next.done) {
          emitModelDiagnostic(options, { type: 'response', source: 'adapter_error', data: { reason: 'incomplete_output' } });
          yield { type: 'error', snapshot: content.snapshot(), stopReason: 'incomplete_output', usage: null };
          return;
        }
        const event = next.value;
        if (event.type === 'done') {
          emitModelDiagnostic(options, { type: 'response', source: 'sdk_message', data: event.message });
          const snapshot = content.finish(event.message, false);
          const reason = finishReason(event.message.stopReason);
          if (!reason || content.invalidArguments) {
            yield { type: 'error', snapshot, stopReason: event.message.stopReason === 'aborted' ? 'aborted' : 'invalid_output',
              usage: normalizeUsage(event.message.usage, reported) };
          } else {
            yield { type: 'done', snapshot, finishReason: reason, usage: normalizeUsage(event.message.usage, reported) };
          }
          return;
        }
        if (event.type === 'error') {
          emitModelDiagnostic(options, { type: 'response', source: 'sdk_error', data: event.error });
          yield { type: 'error', snapshot: content.finish(event.error, true),
            stopReason: event.reason === 'aborted' ? 'aborted' : providerFailure ?? modelStopReason(event.error),
            usage: normalizeUsage(event.error.usage, reported) };
          return;
        }
        const delta = content.accept(event);
        if (delta) yield { type: 'delta', delta };
      }
    } catch (error) {
      if (attempted) emitModelDiagnostic(options, { type: 'response', source: 'adapter_error',
        data: { reason: options.signal.aborted ? 'aborted' : providerFailure ?? modelStopReason(error), error } });
      if (attempted && !announced) yield { type: 'request_started' };
      yield { type: 'error', snapshot: content.snapshot(),
        stopReason: options.signal.aborted ? 'aborted' : providerFailure ?? modelStopReason(error), usage: null };
    } finally {
      observing = false;
      options.signal.removeEventListener('abort', cancel);
      // An uncooperative return() must not delay releasing the run.
      if (iterator?.return) {
        try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Best-effort cleanup. */ }
      }
    }
  }
}
