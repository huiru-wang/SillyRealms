import { RuntimeError } from '../shared/errors.js';
import { ErrorCodes } from '../../common/error-codes.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { debugLog } from '../../common/debug.js';
import { hashRequest, measureWirePayload, supportsLocalMeasurement, type Measurement } from '../context/budget.js';
import { stateTool } from '../tools/state-tool.js';
import type { AssistantMessageEvent, Context, Model, Api, ToolChoice } from '@earendil-works/pi-ai';

/** Map mandatory tool choice to the provider's wire protocol when supported. */
export function requiredToolChoice(model: Model<Api>): ToolChoice | undefined {
  if (model.api === 'openai-completions' || model.api === 'openai-responses' ||
      model.api === 'mistral-conversations' || model.api === 'openai-codex-responses') return 'required' as ToolChoice;
  if (model.api === 'anthropic-messages' || model.api === 'google-generative-ai' ||
      model.api === 'google-vertex' || model.api === 'bedrock-converse-stream') return 'any' as ToolChoice;
  return undefined;
}

export interface ModelGateway {
  resolve(provider: string, model: string): Model<Api> | undefined;
  stream(model: Model<Api>, context: Context, options: { apiKey:string; signal:AbortSignal; maxTokens:number; temperature?:number; toolChoice?:ToolChoice; wireFingerprint?:string }): AsyncIterable<AssistantMessageEvent>;
  measure?(model: Model<Api>, context: Context, options: { maxTokens: number; temperature?: number; toolChoice?: ToolChoice; signal?: AbortSignal }): Promise<Measurement>;
  supportsDirect?(model: Model<Api>): boolean;
  toolVerified(provider: string, model: string): boolean;
  verify?(provider: string, model: string, apiKey: string): Promise<boolean>;
}
export class PiGateway implements ModelGateway {
  private models = builtinModels();
  private verified = new Set<string>();
  resolve(provider:string, model:string) {
    const value = this.models.getModel(provider, model);
    if (!value) return undefined;
    // DeepSeek's published V4.1 encoding explicitly supports mid-conversation system messages.
    // Pi 1.5.0's flash catalog omits this flag; scope the adaptation to that documented endpoint.
    if (supportsLocalMeasurement(value)) return { ...value, compat: { ...value.compat, supportsMidConvoSystemMessages: true } };
    return value;
  }
  supportsDirect(model: Model<Api>): boolean {
    return model.api === 'openai-completions' && (model as Model<'openai-completions'>).compat?.supportsMidConvoSystemMessages === true;
  }
  async measure(model: Model<Api>, context: Context, options: { maxTokens: number; temperature?: number; toolChoice?: ToolChoice; signal?: AbortSignal }): Promise<Measurement> {
    if (!supportsLocalMeasurement(model)) return { tokens: null, method: 'unsupported', quality: 'unknown', version: 'pi-ai/1.5.0' };
    let payload: unknown;
    // Build with the real SDK, but stop before transport. The separate fetch guard prevents
    // network access even if a future SDK fails to invoke onPayload.
    const stream = this.models.streamSimple(model, context, {
      ...options, apiKey: 'sr-offline-preview', maxRetries: 0,
      fetch: async () => { throw new Error('SR_OFFLINE_PREVIEW_ONLY'); },
      onPayload: value => { payload = value; throw new Error('SR_OFFLINE_PREVIEW_ONLY'); },
    });
    for await (const _event of stream) { /* SDK closes with the deliberate local error. */ }
    return measureWirePayload(model, payload);
  }
  async *stream(model:Model<Api>, context:Context, options:{apiKey:string;signal:AbortSignal;maxTokens:number;temperature?:number;toolChoice?:ToolChoice;wireFingerprint?:string}) {
    let changed = false;
    const stream = this.models.streamSimple(model,context,{...options,maxRetries:0,onPayload:(payload, selected) => {
      const fingerprint = hashRequest(payload);
      if (options.wireFingerprint && options.wireFingerprint !== fingerprint) {
        changed = true;
        throw new RuntimeError(ErrorCodes.PREPARED_REQUEST_CHANGED);
      }
      debugLog('模型请求元数据', {provider:selected.provider,model:selected.id,fingerprint});
    }});
    for await (const event of stream) {
      if (changed) throw new RuntimeError(ErrorCodes.PREPARED_REQUEST_CHANGED);
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
