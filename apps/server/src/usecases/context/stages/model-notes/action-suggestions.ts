import type { ActionSuggestionsOutput } from '../../../../modules/sessions/service.js';
import { record, serializeNoteJson } from './serialization.js';
import type { ModelNoteSource } from './types.js';

export const actionSuggestionNotes: ModelNoteSource = {
  source: 'action-suggestions',
  build(entry) {
    if (entry.type !== 'message' || entry.role !== 'assistant') return undefined;
    const output = record(entry.capabilities?.actionSuggestions);
    const candidates = (output?.status === 'success' || output?.status === 'partial_success') && Array.isArray(output.items)
      ? output.items : [];
    const items: ActionSuggestionsOutput['items'] = [];
    const seen = new Set<string>();
    for (const value of candidates) {
      if (typeof value !== 'string') continue;
      const item = value.trim();
      if (!item || [...item].length > 50 || seen.has(item)) continue;
      seen.add(item); items.push(item);
    }
    return '<action_suggestions>' + serializeNoteJson(items) + '</action_suggestions>';
  },
};
