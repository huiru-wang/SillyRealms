import { ErrorCodes } from '../../common/error-codes.js';
import type { ParsedBlock } from './extension-parser.js';
import type { ActionSuggestionsResult, StateUpdateResult } from './extension-contract.js';

export function handleActionSuggestions(block: ParsedBlock | undefined, initial: ActionSuggestionsResult,
  state: StateUpdateResult, count: number): ActionSuggestionsResult {
  const result = structuredClone(initial);
  if (result.status === 'disabled') {
    if (block) result.warningCodes.push('unexpected_disabled_block');
    return result;
  }
  if (['partial', 'failed', 'cancelled', 'pending'].includes(state.status)) {
    result.status = state.status === 'cancelled' ? 'cancelled' : 'blocked';
    result.blockedBy = state.status === 'partial' ? 'state_partial' : 'state_failed';
    return result;
  }
  if (!block || block.error || !Array.isArray(block.value) || block.value.length > 4 ||
      block.value.some(value => typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 120)) {
    result.status = 'failed'; result.errorCode = ErrorCodes.ACTION_SUGGESTIONS_INVALID; return result;
  }
  const values = (block.value as string[]).map(value => value.trim());
  result.items = [...new Set(values)];
  if (result.items.length !== values.length) result.warningCodes.push('duplicate_suggestion');
  if (values.length !== count) result.warningCodes.push('suggestion_count_mismatch');
  result.status = 'ready';
  return result;
}
