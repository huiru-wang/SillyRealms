import { z } from 'zod';
import { ErrorCodes } from '../common/error-codes.js';
import { RuntimeError } from '../runtime/shared/errors.js';
export const SAFETY_TOKENS = 1024;
const tokens = z.number().int().min(2).max(Number.MAX_SAFE_INTEGER);
export const budgetSchema = z.object({strategy:z.enum(['rolling_summary','sliding_window']),max_context_tokens:tokens,max_output_tokens:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)});
export type PresetBudget = z.infer<typeof budgetSchema>;
export function fraction(value:number,numerator:number):number { return Number(BigInt(value)*BigInt(numerator)/100n); }
export function resolveBudget(value:unknown,model:{contextWindow:number;maxTokens:number}):PresetBudget {
 const parsed=budgetSchema.safeParse(value);
 if(!parsed.success || !Number.isSafeInteger(model.contextWindow)||model.contextWindow<=0||!Number.isSafeInteger(model.maxTokens)||model.maxTokens<=0) throw new RuntimeError(ErrorCodes.INVALID_PRESET_BUDGET);
 const budget=parsed.data,cap=Math.min(fraction(model.contextWindow,80),model.contextWindow-budget.max_output_tokens-SAFETY_TOKENS);
 if(budget.max_context_tokens>cap||budget.max_output_tokens>model.maxTokens)throw new RuntimeError(ErrorCodes.INVALID_PRESET_BUDGET);
 return budget;
}
