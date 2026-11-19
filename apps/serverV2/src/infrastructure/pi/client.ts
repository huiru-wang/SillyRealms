import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, SimpleStreamOptions, StopReason } from '@earendil-works/pi-ai';
import { AppError, type ErrorCode } from '../../errors.js';
import { hasInputUsageReport, normalizeUsage, type PiUsage } from './usage.js';

export type { PiUsage } from './usage.js';
export type PiModel = Model<Api>;
export type PiMessage = { role: 'system' | 'user' | 'assistant'; content: string; timestamp?: number };
export type PiOptions = {
  apiKey: string; signal: AbortSignal; maxTokens: number; temperature?: number; thinkingEnabled?: boolean;
};
export type PiModelInfo = {
  providerId: string; modelId: string; name: string; contextWindow: number; maxTokens: number;
  reasoning: boolean; narrativeCompatible: boolean; supportsMidConversationSystemMessages: boolean;
};
export type PiEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'done'; text: string; stopReason: StopReason; hasToolCalls: boolean; usage: PiUsage | null }
  | { type: 'error'; errorCode: ErrorCode; text: string; usage: PiUsage | null };

/** Narrow SDK seam for finite iterator tests; there is only one production implementation. */
export type PiSdk = {
  getProviders(): readonly { id: string }[];
  getModels(provider?: string): readonly PiModel[];
  getModel(provider: string, id: string): PiModel | undefined;
  streamSimple(model: PiModel, context: Context, options: SimpleStreamOptions): AsyncIterable<AssistantMessageEvent>;
};

function supportsMidConversationSystemMessages(model: PiModel): boolean {
  return model.api === 'openai-completions'
    && (model as Model<'openai-completions'>).compat?.supportsMidConvoSystemMessages === true;
}

/** Pi 1.5.0 omits this catalog flag only on the verified DeepSeek V4.1 Flash endpoint. */
function adaptModel(model: PiModel): PiModel {
  let deepSeekFlash = false;
  try {
    deepSeekFlash = model.api === 'openai-completions' && model.provider === 'deepseek'
      && model.id === 'deepseek-flash' && /V4\.1/.test(model.name)
      && new URL(model.baseUrl).hostname === 'api.deepseek.com';
  } catch { /* An invalid endpoint cannot receive a compatibility exception. */ }
  return deepSeekFlash ? { ...model, compat: { ...model.compat, supportsMidConvoSystemMessages: true } } : model;
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

function textOf(message: AssistantMessage): string {
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('');
}

function sdkContext(model: PiModel, messages: readonly PiMessage[]): Context {
  return {
    messages: messages.map(message => {
      const timestamp = message.timestamp ?? 0;
      if (message.role !== 'assistant') return { role: message.role, content: message.content, timestamp };
      return {
        role: 'assistant', content: [{ type: 'text', text: message.content }],
        api: model.api, provider: model.provider, model: model.id, timestamp, stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
    }),
  };
}

export class PiClient {
  constructor(private readonly sdk: PiSdk = builtinModels()) {}

  listModels(): PiModelInfo[] {
    return this.sdk.getProviders().flatMap(provider => this.sdk.getModels(provider.id).map(original => {
      const model = adaptModel(original);
      const ordered = supportsMidConversationSystemMessages(model);
      return { providerId: model.provider, modelId: model.id, name: model.name,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning,
        narrativeCompatible: ordered, supportsMidConversationSystemMessages: ordered };
    }));
  }

  resolve(providerId: string, modelId: string): PiModel {
    const model = this.sdk.getModel(providerId, modelId);
    if (!model) throw new AppError('MODEL_NOT_FOUND');
    return adaptModel(model);
  }

  assertMessageOrder(model: PiModel, messages: readonly PiMessage[]): void {
    let conversationStarted = false;
    for (const message of messages) {
      if (message.role !== 'system') conversationStarted = true;
      else if (conversationStarted && !supportsMidConversationSystemMessages(model)) {
        throw new AppError('MODEL_CAPABILITY_UNSUPPORTED');
      }
    }
  }

  /** One SDK request. Cancellation releases the local consumer even if the provider ignores its signal. */
  async *stream(model: PiModel, messages: readonly PiMessage[], options: PiOptions): AsyncGenerator<PiEvent> {
    if (!options.apiKey?.trim()) throw new AppError('CREDENTIAL_NOT_CONFIGURED');
    this.assertMessageOrder(model, messages);
    if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0 || options.maxTokens > model.maxTokens) {
      throw new AppError('MODEL_CAPABILITY_UNSUPPORTED');
    }

    let reported = false;
    let providerFailure: ErrorCode | undefined;
    let partialText = '';
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
    const marker = Symbol('aborted');
    let cancel!: () => void;
    const aborted = new Promise<typeof marker>(resolve => { cancel = () => resolve(marker); });
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    try {
      if (options.signal.aborted) throw new AppError('RUN_STOPPED');
      iterator = this.sdk.streamSimple(model, sdkContext(model, messages), {
        apiKey: options.apiKey, signal: options.signal, maxTokens: options.maxTokens,
        temperature: options.temperature,
        reasoning: options.thinkingEnabled && model.reasoning ? 'medium' : undefined,
        maxRetries: 0,
        onProviderStreamEvent: raw => {
          reported ||= hasInputUsageReport(raw);
          const code = providerErrorCode(raw);
          if (code === 'PROVIDER_CONTEXT_WINDOW_EXCEEDED') providerFailure = code;
        },
      })[Symbol.asyncIterator]();

      while (true) {
        if (options.signal.aborted) throw new AppError('RUN_STOPPED');
        const next = await Promise.race([iterator.next(), aborted]);
        if (next === marker || options.signal.aborted) throw new AppError('RUN_STOPPED');
        if (next.done) return;
        const event = next.value;
        if (event.type === 'text_delta') {
          partialText += event.delta;
          if (event.delta) yield { type: 'text_delta', delta: event.delta };
        } else if (event.type === 'done') {
          yield { type: 'done', text: textOf(event.message), stopReason: event.message.stopReason,
            hasToolCalls: event.message.content.some(part => part.type === 'toolCall'),
            usage: normalizeUsage(event.message.usage, reported) };
          return;
        } else if (event.type === 'error') {
          yield { type: 'error', errorCode: event.reason === 'aborted' ? 'RUN_STOPPED'
            : providerFailure ?? providerErrorCode(event.error),
            text: textOf(event.error) || partialText, usage: normalizeUsage(event.error.usage, reported) };
          return;
        }
      }
    } catch (error) {
      yield { type: 'error', errorCode: options.signal.aborted ? 'RUN_STOPPED' : providerErrorCode(error),
        text: partialText, usage: null };
    } finally {
      options.signal.removeEventListener('abort', cancel);
      // Some SDK/provider iterators wait forever in return(); do not delay releasing the run.
      if (iterator?.return) {
        try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Best-effort cleanup. */ }
      }
    }
  }
}
