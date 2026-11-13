import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Tokenizer } from '@huggingface/tokenizers';
import type { Api, Context, Model, ToolChoice } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../common/error-codes.js';
import { RuntimeError } from '../shared/errors.js';
import type { ContextPolicy, ExecutionMode } from '../types.js';

export const ADAPTER_VERSION = 'pi-ai/1.5.0:sr/1';
export const COUNTER_VERSION = 'deepseek-v41:81f64d1248a68ce3:hf-tokenizers/0.2.0';
export type Measurement = {
  tokens: number | null; method: string; quality: 'exact' | 'estimated' | 'unknown';
  version: string; wireFingerprint?: string;
};
export type BudgetReport = Measurement & {
  modelId: string; provider: string; fingerprint: string; mode: ExecutionMode;
  purpose: 'generation' | 'continuation' | 'summary'; effectiveWindow: number;
  inputAllowance: number; reservedOutput: number; safetyMargin: number; fits: boolean;
};
type RequestBase = {
  model: Model<Api>; purpose: BudgetReport['purpose']; fingerprint: string;
  report: BudgetReport; output: number; temperature?: number;
};
export type PreparedRequest =
  | (RequestBase & { mode: 'direct'; context: Omit<Context, 'tools'> & { tools?: never }; toolChoice?: never })
  | (RequestBase & { mode: 'agent'; context: Context; toolChoice?: ToolChoice });
export function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function requestFingerprint(model: Model<Api>, context: Context, options: {
  maxTokens: number; temperature?: number; toolChoice?: ToolChoice;
}): string {
  return hashRequest({ model, context, output: options.maxTokens, temperature: options.temperature, toolChoice: options.toolChoice });
}
let tokenizer: Tokenizer | undefined;
export function countDeepSeekText(text: string): number {
  tokenizer ??= new Tokenizer(JSON.parse(gunzipSync(readFileSync(
    new URL('../model/tokenizers/deepseek-v41.json.gz', import.meta.url))).toString('utf8')), {});
  return tokenizer.encode(text, { add_special_tokens: false }).ids.length;
}
export function supportsLocalMeasurement(model: Model<Api>): boolean {
  return model.api === 'openai-completions' && model.provider === 'deepseek' &&
    model.id === 'deepseek-flash' && /V4\.1/.test(model.name) &&
    new URL(model.baseUrl).hostname === 'api.deepseek.com';
}
/** Tokenize the SDK's wire input, then conservatively reserve chat-template overhead.
 * Text BPE is real; provider wrapping remains estimated. Never report this as billable usage.
 * Supported scope is deliberately one verified text-only adapter, not all OpenAI-compatible APIs.
 */
export function measureWirePayload(model: Model<Api>, payload: unknown): Measurement {
  const unknown: Measurement = { tokens: null, method: 'unsupported', quality: 'unknown', version: ADAPTER_VERSION };
  if (!supportsLocalMeasurement(model) || !payload || typeof payload !== 'object') return unknown;
  const value = payload as Record<string, unknown>;
  if (!Array.isArray(value.messages)) return unknown;
  for (const item of value.messages) {
    if (!item || typeof item !== 'object') return unknown;
    const content = (item as Record<string, unknown>).content;
    if (Array.isArray(content) && content.some(part => !part || part.type !== 'text')) return unknown;
  }
  const input = { messages: value.messages, tools: value.tools, tool_choice: value.tool_choice,
    thinking: value.thinking, reasoning_effort: value.reasoning_effort };
  const encoded = countDeepSeekText(JSON.stringify(input));
  const tools = Array.isArray(value.tools) ? value.tools.length : 0;
  return {
    tokens: Math.ceil(encoded * 1.15) + value.messages.length * 32 + tools * 128 + 128,
    method: 'deepseek-v41-bpe-wire-estimate', quality: 'estimated', version: COUNTER_VERSION,
    wireFingerprint: hashRequest(payload),
  };
}
export function inputAllowance(model: Model<Api>, policy: ContextPolicy, output: number): {
  effectiveWindow: number; inputAllowance: number;
} {
  const windows = { compact: 131_072, standard: 262_144, extended: 524_288 };
  const window = Math.min(windows[policy.windowPreset], model.contextWindow);
  const allowance = window - output - policy.safetyMarginTokens;
  if (!Number.isFinite(window) || !Number.isInteger(output) || output < 1 ||
      output > model.maxTokens || !Number.isFinite(allowance) || allowance <= 0 ||
      !Number.isFinite(policy.safetyMarginTokens) || policy.safetyMarginTokens < 0)
    throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
  return { effectiveWindow: window, inputAllowance: allowance };
}
export function summaryInputLimit(model: Model<Api>, policy: ContextPolicy): number {
  const ratio = policy.summary.inputRatio;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new RuntimeError(ErrorCodes.INVALID_PRESET_BUDGET);
  const budget = inputAllowance(model, policy, policy.summary.maxOutputTokens);
  const limit = Math.min(Math.floor(budget.effectiveWindow * ratio), budget.inputAllowance);
  if (limit <= 0) throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
  return limit;
}
export function evaluateBudget(args: {
  model: Model<Api>; context: Context; output: number; temperature?: number; toolChoice?: ToolChoice;
  mode: ExecutionMode; purpose: BudgetReport['purpose']; policy: ContextPolicy; measurement: Measurement;
}): BudgetReport {
  const budget = inputAllowance(args.model, args.policy, args.output);
  const allowance = args.purpose === 'summary' ? summaryInputLimit(args.model, args.policy) : budget.inputAllowance;
  const measured = args.measurement;
  const valid = measured.quality !== 'unknown' && measured.tokens !== null && Number.isSafeInteger(measured.tokens) && measured.tokens >= 0;
  return { ...measured, modelId: args.model.id, provider: args.model.provider,
    fingerprint: requestFingerprint(args.model, args.context, { maxTokens: args.output, temperature: args.temperature, toolChoice: args.toolChoice }),
    mode: args.mode, purpose: args.purpose, effectiveWindow: budget.effectiveWindow,
    inputAllowance: allowance, reservedOutput: args.output, safetyMargin: args.policy.safetyMarginTokens,
    fits: valid && measured.tokens! <= allowance };
}
export function requireMeasured(report: BudgetReport): void {
  if (report.quality === 'unknown' || report.tokens === null || !Number.isSafeInteger(report.tokens) || report.tokens < 0)
    throw new RuntimeError(ErrorCodes.CONTEXT_MEASUREMENT_UNSUPPORTED);
}
export function assertPreparedRequest(request: PreparedRequest, model: Model<Api>, context: Context, options: {
  maxTokens: number; temperature?: number; toolChoice?: ToolChoice;
}): void {
  if (!request.report.fits || request.fingerprint !== requestFingerprint(model, context, options))
    throw new RuntimeError(ErrorCodes.PREPARED_REQUEST_CHANGED);
  if (request.mode === 'direct' && (context.tools?.length || options.toolChoice !== undefined))
    throw new RuntimeError(ErrorCodes.INVALID_TOOL_CALL);
}
