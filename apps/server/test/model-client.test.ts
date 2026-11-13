import { expect, it } from 'vitest';
import type { Api, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import { ModelClient } from '../src/runtime/model/model-client.js';
import type { ModelGateway } from '../src/runtime/model/pi-gateway.js';

const model: Model<Api> = {
  id: 'fake', name: 'fake', provider: 'fake', api: 'openai-completions', baseUrl: 'http://localhost',
  reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768, maxTokens: 1024,
};

it('stops waiting for an uncooperative provider without consuming late responses', async () => {
  let returned = false;
  let release!: () => void;
  const gateway: ModelGateway = {
    resolve: () => model,
    supportsDirect:()=>true,toolVerified: () => true,
    stream: () => ({
      [Symbol.asyncIterator]() {
        let nextCount = 0;
        return {
          next(): Promise<IteratorResult<AssistantMessageEvent>> {
            nextCount++;
            if (nextCount === 1) {
              return Promise.resolve({
                done: false, value: { type: 'text_delta', delta: 'hi', contentIndex: 0, partial: {} as never },
              });
            }
            return new Promise(resolve => {
              release = () => resolve({ done: false, value: { type: 'text_delta', delta: 'late', contentIndex: 0, partial: {} as never } });
            });
          },
          return: async () => { returned = true; return { done: true as const, value: undefined }; },
        };
      },
    }),
  };
  const client = new ModelClient(gateway);
  const controller = new AbortController();
  const events = client.events(model, { messages: [] }, {
    apiKey: 'fake', signal: controller.signal, maxTokens: 64,
  });
  expect((await events.next()).value?.type).toBe('text_delta');
  const pending = events.next();
  controller.abort();
  expect((await pending).done).toBe(true);
  release();
  expect(returned).toBe(true);
});
