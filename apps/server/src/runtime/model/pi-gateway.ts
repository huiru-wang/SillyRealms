import { RuntimeError } from '../shared/errors.js';
import { ErrorCodes, normalizeError, type ErrorCode } from '../../common/error-codes.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { debugLog, type DebugContext } from '../../common/debug.js';
import { hashRequest } from '../context/budget.js';
import { stateTool } from '../tools/state-tool.js';
import type { AssistantMessageEvent, AssistantMessage, Context, Model, Api, ToolChoice } from '@earendil-works/pi-ai';

/** Map mandatory tool choice to the provider's wire protocol when supported. */
export function requiredToolChoice(model: Model<Api>): ToolChoice | undefined {
  if (model.api === 'openai-completions' || model.api === 'openai-responses' ||
      model.api === 'mistral-conversations' || model.api === 'openai-codex-responses') return 'required' as ToolChoice;
  if (model.api === 'anthropic-messages' || model.api === 'google-generative-ai' ||
      model.api === 'google-vertex' || model.api === 'bedrock-converse-stream') return 'any' as ToolChoice;
  return undefined;
}

/** Keep the verified Direct ordering adaptation independent of token estimation. */
function supportsDeepSeekMidConversationSystem(model: Model<Api>): boolean {
  return model.api === 'openai-completions' && model.provider === 'deepseek' &&
    model.id === 'deepseek-flash' && /V4\.1/.test(model.name) &&
    new URL(model.baseUrl).hostname === 'api.deepseek.com';
}

export interface ModelGateway {
  resolve(provider: string, model: string): Model<Api> | undefined;
  stream(model: Model<Api>, context: Context, options: { apiKey:string; signal:AbortSignal; maxTokens:number; temperature?:number; toolChoice?:ToolChoice; wireFingerprint?:string; debugContext?:DebugContext }): AsyncIterable<AssistantMessageEvent>;
  preview?(model: Model<Api>, context: Context, options: { maxTokens: number; temperature?: number; toolChoice?: ToolChoice; signal?: AbortSignal }): Promise<string | undefined>;
  usageReported?(message: AssistantMessage): boolean;
  supportsDirect?(model: Model<Api>): boolean;
  toolVerified(provider: string, model: string): boolean;
  verify?(provider: string, model: string, apiKey: string): Promise<boolean>;
}
export class PiGateway implements ModelGateway {
  private models = builtinModels();
  private usageEvidence = new WeakMap<AssistantMessage, boolean>();
  usageReported(message: AssistantMessage): boolean { return this.usageEvidence.get(message) === true; }
  private verified = new Set<string>();
  resolve(provider:string, model:string) {
    const value = this.models.getModel(provider, model);
    if (!value) return undefined;
    // DeepSeek's published V4.1 encoding explicitly supports mid-conversation system messages.
    // Pi 1.5.0's flash catalog omits this flag; scope the adaptation to that documented endpoint.
    if (supportsDeepSeekMidConversationSystem(value)) return { ...value, compat: { ...value.compat, supportsMidConvoSystemMessages: true } };
    return value;
  }
  supportsDirect(model: Model<Api>): boolean {
    return model.api === 'openai-completions' && (model as Model<'openai-completions'>).compat?.supportsMidConvoSystemMessages === true;
  }
  async preview(model: Model<Api>, context: Context, options: { maxTokens: number; temperature?: number; toolChoice?: ToolChoice; signal?: AbortSignal }): Promise<string | undefined> {
    // Only adapters with an injectable fetch transport can be previewed without network access.
    if (!['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'].includes(model.api)) return undefined;
    let payload: unknown;
    const stream = this.models.streamSimple(model, context, { ...options, apiKey: 'sr-offline-preview', maxRetries: 0,
      fetch: async () => { throw new Error('SR_OFFLINE_PREVIEW_ONLY'); },
      onPayload: value => { payload = value; throw new Error('SR_OFFLINE_PREVIEW_ONLY'); } });
    for await (const _event of stream) { /* locally stopped before transport */ }
    if (payload === undefined) throw new RuntimeError(ErrorCodes.PREPARED_REQUEST_CHANGED);
    return hashRequest(payload);
  }
  async *stream(model:Model<Api>, context:Context, options:{apiKey:string;signal:AbortSignal;maxTokens:number;temperature?:number;toolChoice?:ToolChoice;wireFingerprint?:string;debugContext?:DebugContext}) {
    let changed = false, reported = false;
    let providerFailure: ErrorCode | undefined;
    const stream = this.models.streamSimple(model,context,{...options,maxRetries:0,onProviderStreamEvent: (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return;
      const value = raw as Record<string, any>;
      const usage = value.usage ?? value.message?.usage ?? value.response?.usage ?? value.usageMetadata;
      if (usage && typeof usage === 'object' && ['prompt_tokens', 'input_tokens', 'promptTokenCount']
        .some(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) reported = true;
      const code = providerErrorCode(value.error);
      if (code === ErrorCodes.PROVIDER_CONTEXT_WINDOW_EXCEEDED) providerFailure = code;
    },onPayload:(payload, selected) => {
      const fingerprint = hashRequest(payload);
      if (options.wireFingerprint && options.wireFingerprint !== fingerprint) {
        changed = true;
        throw new RuntimeError(ErrorCodes.PREPARED_REQUEST_CHANGED);
      }
      debugLog('MODEL REQUEST', {source:'provider-payload',provider:selected.provider,model:selected.id,fingerprint,payload},
        {context:options.debugContext,secrets:[options.apiKey]});
    }});
    for await (const event of stream) {
      if (changed) throw new RuntimeError(ErrorCodes.PREPARED_REQUEST_CHANGED);
      if (event.type === 'done' || event.type === 'error') {
        const message = event.type === 'done' ? event.message : event.error;
        // An output-only report cannot establish that the SDK's default input=0 is real.
        this.usageEvidence.set(message, reported || [message.usage?.input, message.usage?.cacheRead, message.usage?.cacheWrite]
          .some(v => typeof v === 'number' && v > 0));
        if (event.type === 'error' && providerFailure) message.errorMessage = providerFailure;
      }
      yield event;
    }
    if (changed) throw new RuntimeError(ErrorCodes.PREPARED_REQUEST_CHANGED);
  }
  toolVerified(provider:string, model:string) { return this.verified.has(`${provider}\0${model}`); }
  async verify(provider:string, id:string, apiKey:string):Promise<boolean> {
    const model = this.resolve(provider,id); if (!model) throw new Error(ErrorCodes.MODEL_NOT_FOUND);
    const controller = new AbortController(); const timeout = setTimeout(()=>controller.abort(),30000);
    try {
      let done = false, called = false;
      const context:Context = { messages:[{role:'user',content:'Write one short narrative sentence, then call update_state with {updates:[{path:"test.value",value:1}]}. Do not write after the tool.',timestamp:Date.now()}], tools:[stateTool] };
      for await (const event of this.stream(model,context,{apiKey,signal:controller.signal,maxTokens:128})) {
        if (event.type === 'error') throw new Error(ErrorCodes.PROVIDER_TEST_FAILED);
        if (event.type === 'done') { done = true; called = event.message.content.some(p => p.type === 'toolCall' && p.name === 'update_state' && !p.argumentsError && Array.isArray(p.arguments.updates) && p.arguments.updates.length === 1 && p.arguments.updates[0]?.path === 'test.value' && p.arguments.updates[0]?.value === 1); }
      }
      if (!done) throw new Error(ErrorCodes.PROVIDER_TEST_FAILED);
      if (called) this.verified.add(`${provider}\0${id}`);
      return called;
    } finally { clearTimeout(timeout); }
  }
}

/** Known structured codes only; arbitrary error prose is never exposed or guessed as overflow. */
export function providerErrorCode(error: unknown): ErrorCode {
  if (error instanceof RuntimeError) return error.code;
  if (error && typeof error === 'object') {
    const value = error as Record<string, any>;
    for (const candidate of [value.code, value.error?.code, value.type, value.errorMessage]) {
      if (candidate === ErrorCodes.PROVIDER_CONTEXT_WINDOW_EXCEEDED || ['context_length_exceeded', 'context_window_exceeded'].includes(candidate))
        return ErrorCodes.PROVIDER_CONTEXT_WINDOW_EXCEEDED;
    }
    if (typeof value.errorMessage === 'string') {
      // Pi preserves some SDK error bodies as "400: {json}" or "400 {json}".
      // Parse only that framing; never classify arbitrary human-readable prose.
      const body = value.errorMessage.replace(/^[45]\d{2}:?\s+(?=\{)/u, '');
      try { const parsed = JSON.parse(body); if (parsed && typeof parsed === 'object') return providerErrorCode(parsed); } catch { /* not structured */ }
    }
  }
  return normalizeError(error, ErrorCodes.PROVIDER_ERROR).errorCode;
}
