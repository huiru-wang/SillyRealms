import type { ParsedBlock } from './parser.js';
import type { ActionSuggestionsResult } from './contracts.js';

export function handleActionSuggestions(block: ParsedBlock | undefined, initial: ActionSuggestionsResult): ActionSuggestionsResult {
  const result = structuredClone(initial);
  if (result.status !== 'pending') {
    return result;
  }
  if (!block || block.error || !Array.isArray(block.value) || block.value.length !== 3 ||
      block.value.some(value => typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 50)) {
    result.status = 'failed'; return result;
  }
  const values = (block.value as string[]).map(value => value.trim());
  if(new Set(values).size!==3){result.status='failed';return result;}
  result.items=values;
  result.status = 'ready';
  return result;
}
