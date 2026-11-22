import { describe, expect, it, vi } from 'vitest';
import { builtinModels, getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelDiagnostic, SamplingParameters } from '../model/client.js';
import { PiClient, type PiSdk } from './client.js';
import { resolveSampling } from './sampling.js';

const registry = builtinModels();
const flash = getBuiltinModel('deepseek', 'deepseek-flash');
const pro = getBuiltinModel('deepseek', 'deepseek-v4-pro');
const router = getBuiltinModel('openrouter', 'openai/gpt-4o-mini');
const preferences = { temperature: 0.735, topP: 0.97, frequencyPenalty: -0.4, presencePenalty: 0 };
const wire = { temperature: 0.735, top_p: 0.97, frequency_penalty: -0.4, presence_penalty: 0 };

// Capture the real SDK-built request in its last pre-transport hook. Never send it.
async function payloadFor(model: Model<Api>, thinkingEnabled: boolean, overrides: SamplingParameters = preferences) {
  const diagnostics: ModelDiagnostic[] = [];
  const transport = vi.fn(async () => { throw new Error('Unexpected network attempt'); });
  const sdk: PiSdk = {
    getModel: () => model, getModels: () => [model], getProviders: () => [],
    streamSimple(selected, context, options) {
      return registry.streamSimple(selected, context, {
        ...options, fetch: transport,
        async onPayload(payload, sdkModel) {
          await options.onPayload?.(payload, sdkModel);
          throw new Error('Captured before transport');
        },
      });
    },
  };
  const client = new PiClient(sdk);
  const stream = client.stream(client.resolve(model.provider, model.id), [{ role: 'user', content: 'test' }], {
    ...overrides, thinkingEnabled, apiKey: 'sk-test', maxTokens: 128, signal: new AbortController().signal,
    onDiagnostic: event => { diagnostics.push(event); },
  });
  for await (const event of stream) { if (event.type === 'error') break; }
  expect(transport).not.toHaveBeenCalled();
  const payload = diagnostics.find(event => event.source === 'provider_payload')?.data;
  expect(payload).toBeDefined();
  return { body: payload as Record<string, unknown>, omitted: diagnostics.find(event => event.source === 'sampling_omitted')?.data };
}

describe('sampling overrides in final SDK requests', () => {
  it('sets all four on the verified route and wins over model and level defaults', async () => {
    const model = { ...router, samplingParams: { top_p: 0.1 }, samplingParamsByThinkingLevel: { off: { temperature: 0.2 } } };
    expect((await payloadFor(model, false)).body).toMatchObject(wire);
    const { body, omitted } = await payloadFor(model, false, {});
    expect(body).toMatchObject({ temperature: 0.2, top_p: 0.1 });
    expect(body).not.toHaveProperty('presence_penalty');
    expect(omitted).toBeUndefined();
  });

  it.each([
    [flash, true, { top_p: 0.97 }], [flash, false, { temperature: 0.735 }],
    [pro, true, {}], [pro, false, { temperature: 0.735, top_p: 0.97 }],
  ] as const)('filters the DeepSeek route and effective thinking mode', async (model, thinking, expected) => {
    const { body, omitted } = await payloadFor(model, thinking);
    expect(body.thinking).toEqual({ type: thinking ? 'enabled' : 'disabled' });
    expect(Object.fromEntries(Object.keys(wire).filter(key => key in body).map(key => [key, body[key]]))).toEqual(expected);
    expect(omitted).toMatchObject({ frequencyPenalty: 'unsupported', presencePenalty: 'unsupported' });
  });

  it('omits values below model limits and preserves allowed boundaries', async () => {
    for (const [model, thinking, lower, invalid] of [[flash, true, 0.95, 0.94], [pro, false, 0.01, 0]] as const) {
      const result = await payloadFor(model, thinking, { topP: invalid });
      expect(result.body).not.toHaveProperty('top_p');
      expect(result.omitted).toEqual({ topP: 'out_of_range' });
      expect((await payloadFor(model, thinking, { topP: lower })).body.top_p).toBe(lower);
    }
  });

  it('distinguishes Responses from chat and preserves native temperature on verified older models', async () => {
    const responses = getBuiltinModel('openai', 'gpt-4.1');
    const { body } = await payloadFor(responses, false);
    expect(body).toMatchObject({ temperature: 0.735, top_p: 0.97 });
    expect(body).not.toHaveProperty('frequency_penalty');
    expect(body).not.toHaveProperty('presence_penalty');
    const claude = getBuiltinModel('anthropic', 'claude-sonnet-4-5');
    expect((await payloadFor(claude, false)).body.temperature).toBe(0.735);
    expect((await payloadFor(claude, true)).body).not.toHaveProperty('temperature');
  });

  it('applies GPT-5.4 overrides only alongside effort none', async () => {
    const model = getBuiltinModel('openai', 'gpt-5.4');
    const active = await payloadFor(model, true);
    expect(active.body).not.toHaveProperty('top_p');
    expect(active.body).not.toHaveProperty('temperature');
    expect(active.omitted).toMatchObject({ temperature: 'mode_fixed', topP: 'mode_fixed' });
    expect((await payloadFor(model, false)).body).toMatchObject({
      reasoning: { effort: 'none' }, temperature: 0.735, top_p: 0.97,
    });
  });

  it('keeps unknown routes, changed endpoints and non-API-key OpenAI sessions on their own defaults', () => {
    for (const model of [{ ...router, baseUrl: 'https://example.invalid' }, { ...router, provider: 'proxy' },
      { ...router, api: 'openai-responses' as const }, { ...router, id: 'unlisted' }]) {
      expect(resolveSampling(model, preferences, undefined, 'sk-test').options).toEqual({});
    }
    expect(resolveSampling(getBuiltinModel('openai', 'gpt-4.1'), preferences, undefined, 'test-token').options).toEqual({});
    expect(resolveSampling({ ...pro, thinkingLevelMap: { off: null } }, preferences, undefined, 'sk-test').options).toEqual({});
  });
});
