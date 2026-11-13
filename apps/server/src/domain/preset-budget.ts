import { z } from 'zod';
import { ErrorCodes } from '../common/error-codes.js';
import { RuntimeError } from '../runtime/shared/errors.js';

export const LEGACY_WINDOWS = { compact: 131072, standard: 262144, extended: 524288 } as const;
export const SAFETY_TOKENS = 1024;
const tokens = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const strategy = z.enum(['rolling_summary', 'sliding_window']);
const numeric = z.object({ strategy: strategy.default('rolling_summary'), max_context_tokens: tokens, max_output_tokens: tokens }).strict();
const legacy = z.object({ context_strategy: z.enum(['compact', 'standard', 'extended']), max_output_tokens: tokens }).strict();
export type PresetBudget = z.infer<typeof numeric>;
export type StoredBudget = PresetBudget & { legacyWindow?: number };
export const budgetInputSchema = z.union([numeric, legacy]).transform((value, ctx): StoredBudget => {
  if (!('context_strategy' in value)) return value;
  const window = LEGACY_WINDOWS[value.context_strategy], input = window - value.max_output_tokens - SAFETY_TOKENS;
  if (input < 2) { ctx.addIssue({ code: 'custom', message: 'Invalid context allowance' }); return z.NEVER; }
  return { strategy: 'rolling_summary', max_context_tokens: input, max_output_tokens: value.max_output_tokens, legacyWindow: window };
});
export const storedBudgetSchema = z.union([numeric.extend({ legacyWindow: tokens.optional() }), legacy]).transform(value =>
  'context_strategy' in value ? budgetInputSchema.parse(value) : value);
export const budgetPatchSchema = z.object({ strategy: strategy.optional(), max_context_tokens: tokens.optional(),
  max_output_tokens: tokens.optional(), context_strategy: legacy.shape.context_strategy.optional() }).strict()
  .refine(value => !(value.context_strategy !== undefined && (value.max_context_tokens !== undefined || value.strategy !== undefined)));
export function publicBudget(value: unknown): PresetBudget {
  const { legacyWindow: _legacy, ...budget } = storedBudgetSchema.parse(value);
  return budget;
}
export function mergeBudget(current: unknown, patch: unknown): StoredBudget {
  const base = storedBudgetSchema.parse(current), changes = budgetPatchSchema.parse(patch ?? {});
  if (changes.context_strategy) return budgetInputSchema.parse({ context_strategy: changes.context_strategy,
    max_output_tokens: changes.max_output_tokens ?? base.max_output_tokens });
  const next = { ...base, ...changes };
  if (changes.max_context_tokens !== undefined) delete next.legacyWindow;
  else if (next.legacyWindow) next.max_context_tokens = next.legacyWindow - next.max_output_tokens - SAFETY_TOKENS;
  return storedBudgetSchema.parse(next);
}
/** Integer arithmetic avoids rounding a configuration one token above the cap. */
export function fraction(value: number, numerator: number): number {
  return Number(BigInt(value) * BigInt(numerator) / 100n);
}
export function resolveBudget(value: unknown, model: { contextWindow: number; maxTokens: number }): PresetBudget {
  const parsed = storedBudgetSchema.safeParse(value);
  if (!parsed.success || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0 ||
      !Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) throw new RuntimeError(ErrorCodes.INVALID_PRESET_BUDGET);
  const { legacyWindow, ...budget } = parsed.data;
  const cap = Math.min(fraction(model.contextWindow, 80), model.contextWindow - budget.max_output_tokens - SAFETY_TOKENS);
  if (legacyWindow) budget.max_context_tokens = Math.min(budget.max_context_tokens, cap);
  if (budget.max_context_tokens < 2 || budget.max_context_tokens > cap || budget.max_output_tokens > model.maxTokens)
    throw new RuntimeError(ErrorCodes.INVALID_PRESET_BUDGET);
  return budget;
}
