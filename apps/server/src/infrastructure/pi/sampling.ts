import { clampThinkingLevel } from '@earendil-works/pi-ai/models';
import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ModelReasoningLevel, SamplingParameters } from '../model/client.js';

type Key = keyof SamplingParameters;
type Range = { min: number; max: number; exclusiveMin?: true };
type Rules = Partial<Record<Key, Range | 'mode_fixed'>>;
const temperature = { min: 0, max: 2 };
const topP = { min: 0, max: 1 };
const penalty = { min: -2, max: 2 };
const wireKeys = {
  temperature: 'temperature', topP: 'top_p', frequencyPenalty: 'frequency_penalty', presencePenalty: 'presence_penalty',
} as const;
const legacyOpenAI = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano']);
const legacyClaude = new Set(['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-5',
  'claude-opus-4-5-20251101', 'claude-opus-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-6']);
const gemini25 = new Set(['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro']);

// The intersections of provider support and pi-ai 1.5.0 transport support. See server-narrative.md.
function rulesFor(model: Model<Api>, reasoning: ModelReasoningLevel | undefined, apiKey: string): Rules | undefined {
  const { id, api, provider, baseUrl } = model;
  const thinking = reasoning !== undefined && clampThinkingLevel(model, reasoning) !== 'off';
  if (provider === 'openrouter' && api === 'openai-completions' && baseUrl === 'https://openrouter.ai/api/v1'
    && id === 'openai/gpt-4o-mini') {
    return { temperature, topP, frequencyPenalty: penalty, presencePenalty: penalty };
  }
  if (provider === 'deepseek' && api === 'openai-completions' && baseUrl === 'https://api.deepseek.com'
    && (id === 'deepseek-flash' || id === 'deepseek-v4-pro')) {
    // When pi cannot send an explicit off switch, DeepSeek's provider default is thinking enabled.
    const active = thinking || model.thinkingLevelMap?.off === null;
    if (id === 'deepseek-flash') {
      return active ? { temperature: 'mode_fixed', topP: { min: 0.95, max: 1 } }
        : { temperature, topP: 'mode_fixed' };
    }
    return active ? { temperature: 'mode_fixed', topP: 'mode_fixed' }
      : { temperature, topP: { ...topP, exclusiveMin: true } };
  }
  if (provider === 'openai' && api === 'openai-responses' && baseUrl === 'https://api.openai.com/v1' && apiKey.startsWith('sk-')) {
    if (legacyOpenAI.has(id)) return { temperature, topP };
    if (id === 'gpt-5.2' || id === 'gpt-5.4') {
      const none = !thinking && model.thinkingLevelMap?.off === 'none';
      return none ? { temperature, topP } : { temperature: 'mode_fixed', topP: 'mode_fixed' };
    }
  }
  if (provider === 'google' && api === 'google-generative-ai' && baseUrl === 'https://generativelanguage.googleapis.com/v1beta'
    && gemini25.has(id)) return { temperature };
  if (provider === 'anthropic' && api === 'anthropic-messages' && baseUrl === 'https://api.anthropic.com' && legacyClaude.has(id)) {
    const compat = (model as Model<'anthropic-messages'>).compat;
    // The pinned Anthropic client uses version 2023-06-01. Its native adapter only exposes temperature.
    return { temperature: reasoning || compat?.supportsTemperature === false || compat?.supportsMidConvoEffort
      ? 'mode_fixed' : { min: 0, max: 1 } };
  }
  return undefined;
}

export function resolveSampling(model: Model<Api>, preferences: SamplingParameters, reasoning: ModelReasoningLevel | undefined, apiKey: string) {
  const rules = rulesFor(model, reasoning, apiKey);
  const omitted: Partial<Record<Key, 'unknown_route' | 'unsupported' | 'mode_fixed' | 'out_of_range'>> = {};
  const options: Pick<SimpleStreamOptions, 'temperature' | 'samplingParams'> = {};
  for (const key of Object.keys(wireKeys) as Key[]) {
    const value = preferences[key];
    if (value === undefined) continue;
    const rule = rules?.[key];
    if (!rule) omitted[key] = rules ? 'unsupported' : 'unknown_route';
    else if (rule === 'mode_fixed') omitted[key] = rule;
    else if (!Number.isFinite(value) || value < rule.min || value > rule.max || (rule.exclusiveMin && value === rule.min)) {
      omitted[key] = 'out_of_range';
    } else if (model.api === 'openai-completions' || model.api === 'openai-responses') {
      // Per-request samplingParams are merged last, including over per-thinking-level catalog defaults.
      (options.samplingParams ??= {})[wireKeys[key]] = value;
    } else if (key === 'temperature') {
      options.temperature = value;
    }
  }
  return { options, omitted };
}
