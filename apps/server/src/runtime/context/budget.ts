import { createHash } from 'node:crypto';
import type { Api, Context, Model, ToolChoice } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../common/error-codes.js';
import { RuntimeError } from '../shared/errors.js';
import type { ContextPolicy } from '../types.js';

type RequestBase = {
  model: Model<Api>; purpose: 'generation' | 'continuation' | 'summary'; fingerprint: string;
  wireFingerprint?: string; strategy?: string; output: number; temperature?: number;
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
export function summaryInputLimit(model: Model<Api>, policy: ContextPolicy): number {
  const ratio = policy.summary.inputRatio;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) throw new RuntimeError(ErrorCodes.INVALID_PRESET_BUDGET);
  const window = model.contextWindow;
  const limit = Math.min(Math.floor(window * ratio), window - policy.summary.maxOutputTokens - policy.safetyMarginTokens);
  if (limit <= 0) throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
  return limit;
}
export function assertPreparedRequest(request: PreparedRequest, model: Model<Api>, context: Context, options: {
  maxTokens: number; temperature?: number; toolChoice?: ToolChoice;
}): void {
  if (request.fingerprint !== requestFingerprint(model, context, options))
    throw new RuntimeError(ErrorCodes.PREPARED_REQUEST_CHANGED);
  if (request.mode === 'direct' && (context.tools?.length || options.toolChoice !== undefined))
    throw new RuntimeError(ErrorCodes.INVALID_TOOL_CALL);
}
