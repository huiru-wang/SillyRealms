import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { stateTool } from './state-tool.js';
import type { AssistantMessageEvent, Context, Model, Api } from '@earendil-works/pi-ai';

export interface ModelGateway {
  resolve(provider: string, model: string): Model<Api> | undefined;
  stream(model: Model<Api>, context: Context, options: { apiKey:string; signal:AbortSignal; maxTokens:number; temperature?:number }): AsyncIterable<AssistantMessageEvent>;
  toolVerified(provider: string, model: string): boolean;
  verify?(provider: string, model: string, apiKey: string): Promise<boolean>;
}
export class PiGateway implements ModelGateway {
  private models = builtinModels();
  private verified = new Set<string>();
  resolve(provider:string, model:string) { return this.models.getModel(provider,model); }
  stream(model:Model<Api>, context:Context, options:{apiKey:string;signal:AbortSignal;maxTokens:number;temperature?:number}) { return this.models.streamSimple(model,context,options); }
  toolVerified(provider:string, model:string) { return this.verified.has(`${provider}\0${model}`); }
  async verify(provider:string, id:string, apiKey:string):Promise<boolean> {
    const model = this.resolve(provider,id); if (!model) throw new Error('MODEL_NOT_FOUND');
    const controller = new AbortController(); const timeout = setTimeout(()=>controller.abort(),30000);
    try {
      let done = false, called = false;
      const context:Context = { messages:[{role:'user',content:'Call the set_state tool with path test.value and value 1. Do not answer in prose.',timestamp:Date.now()}], tools:[stateTool] };
      for await (const event of this.stream(model,context,{apiKey,signal:controller.signal,maxTokens:128})) {
        if (event.type === 'error') throw new Error('PROVIDER_TEST_FAILED');
        if (event.type === 'done') { done = true; called = event.message.content.some(p => p.type === 'toolCall' && p.name === 'set_state' && !p.argumentsError && p.arguments.path === 'test.value' && p.arguments.value === 1); }
      }
      if (!done) throw new Error('PROVIDER_TEST_FAILED');
      if (called) this.verified.add(`${provider}\0${id}`);
      return called;
    } finally { clearTimeout(timeout); }
  }
}
