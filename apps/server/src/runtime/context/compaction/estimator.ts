import type { Context, Message, Model, Api, ToolChoice } from '@earendil-works/pi-ai';
import { fingerprint } from '../../config.js';
import { ErrorCodes } from '../../../common/error-codes.js';
import { RuntimeError } from '../../shared/errors.js';
import type { HistoryItem } from './history.js';

export const ESTIMATOR_VERSION = 'fixed-text/1';
export type InputIdentity = { version: string; settings: string; messages: string[] };
export type InputBaseline = InputIdentity & { inputTokens: number };
export function estimateText(text: string): number {
  let thirds = 0;
  for (const char of text) {
    thirds += char.codePointAt(0)! <= 127 ? 1 : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
      ? 3 : Buffer.byteLength(char, 'utf8') * 3;
  }
  const value = Math.ceil(thirds / 3);
  if (!Number.isSafeInteger(value)) throw new RuntimeError(ErrorCodes.CONTEXT_MEASUREMENT_UNSUPPORTED);
  return value;
}
export function estimateMessage(message: Message): number {
  if (typeof message.content === 'string') return 16 + estimateText(message.content);
  return 16 + message.content.reduce((sum, part) => {
    if (part.type === 'text') return sum + estimateText(part.text);
    if (part.type === 'toolCall') return sum + estimateText(JSON.stringify(part));
    if (part.type === 'thinking') return sum + estimateText(JSON.stringify(part));
    throw new RuntimeError(ErrorCodes.CONTEXT_MEASUREMENT_UNSUPPORTED);
  }, 0);
}
export function estimateHistory(history: HistoryItem[]): number {
  return history.reduce((sum, item) => sum + 16 + estimateText(item.text), 0);
}
export function estimateContext(context: Context): number {
  const result = 64 + (context.systemPrompt ? estimateText(context.systemPrompt) : 0) +
    context.messages.reduce((sum, message) => sum + estimateMessage(message), 0) +
    (context.tools ?? []).reduce((sum, tool) => sum + 32 + estimateText(JSON.stringify(tool)), 0);
  if (!Number.isSafeInteger(result)) throw new RuntimeError(ErrorCodes.CONTEXT_MEASUREMENT_UNSUPPORTED);
  return result;
}
export function inputIdentity(model: Model<Api>, context: Context, options: { mode: string; strategy: string; toolChoice?: ToolChoice }): InputIdentity {
  return { version: ESTIMATOR_VERSION, settings: fingerprint({ model, ...options, systemPrompt: context.systemPrompt, tools: context.tools }),
    messages: context.messages.map(message => {
      const { timestamp: _time, ...value } = message;
      // Usage never affects the provider input; all other protocol fields remain part of the proof.
      if ('usage' in value) delete (value as { usage?: unknown }).usage;
      return fingerprint(value);
    }) };
}
export function estimateInitial(context: Context, identity: InputIdentity, baseline?: InputBaseline): {
  tokens: number; method: 'usage_plus_estimate' | 'full_estimate'; baselineReason?: string;
} {
  if (baseline && Number.isSafeInteger(baseline.inputTokens) && baseline.inputTokens >= 0 &&
      baseline.version === identity.version && baseline.settings === identity.settings &&
      Array.isArray(baseline.messages) && baseline.messages.length <= identity.messages.length && baseline.messages.every((hash, i) => identity.messages[i] === hash)) {
    const tokens = baseline.inputTokens + context.messages.slice(baseline.messages.length).reduce((sum, m) => sum + estimateMessage(m), 0);
    if (Number.isSafeInteger(tokens)) return { tokens, method: 'usage_plus_estimate' };
  }
  return { tokens: estimateContext(context), method: 'full_estimate', baselineReason: baseline ? 'input_changed' : 'no_baseline' };
}
