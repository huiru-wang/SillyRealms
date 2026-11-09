import { ErrorCodes } from '../../common/error-codes.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { debugLog } from '../../common/debug.js';
import { stateTool } from '../tools/state-tool.js';
import type { AssistantMessageEvent, Context, Model, Api, ToolChoice } from '@earendil-works/pi-ai';

/** Concrete pi-ai adapters accept mandatory tool choice despite generic typing. */
export function requiredToolChoice(model: Model<Api>): ToolChoice | undefined {
  if (model.api === 'openai-completions' || model.api === 'openai-responses' ||
      model.api === 'mistral-conversations' || model.api === 'openai-codex-responses') {
    return 'required' as ToolChoice;
  }
  if (model.api === 'anthropic-messages' || model.api === 'google-generative-ai' ||
      model.api === 'google-vertex' || model.api === 'bedrock-converse-stream') {
    return 'any' as ToolChoice;
  }
  return undefined;
}

export interface ModelGateway {
  resolve(provider: string, model: string): Model<Api> | undefined;
  stream(model: Model<Api>, context: Context, options: { apiKey:string; signal:AbortSignal; maxTokens:number; temperature?:number; toolChoice?:ToolChoice }): AsyncIterable<AssistantMessageEvent>;
  toolVerified(provider: string, model: string): boolean;
  verify?(provider: string, model: string, apiKey: string): Promise<boolean>;
}
export class PiGateway implements ModelGateway {
  private models = builtinModels();
  private verified = new Set<string>();
  resolve(provider:string, model:string) { return this.models.getModel(provider,model); }
  stream(model:Model<Api>, context:Context, options:{apiKey:string;signal:AbortSignal;maxTokens:number;temperature?:number;toolChoice?:ToolChoice}) { return this.models.streamSimple(model,context,{...options,onPayload:(payload, selected) => { debugLog('模型实际请求', {provider:selected.provider,model:selected.id,payload}); }}); }
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
