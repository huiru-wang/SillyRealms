import type { ActionSuggestionsOutput } from '../../../../modules/sessions/service.js';
import { record, serializeNoteJson } from './serialization.js';
import type { ModelNoteSource } from './types.js';

export const actionSuggestionNotes: ModelNoteSource = {
  source: 'action-suggestions',
  build(entry) {
    if (entry.type !== 'message' || entry.role !== 'assistant') return undefined;
    const output = record(record(entry.extData.output)?.actionSuggestions);
    if (!output || (output.status !== 'success' && output.status !== 'partial_success') || !Array.isArray(output.items)) return undefined;
    const items: ActionSuggestionsOutput['items'] = [];
    const seen = new Set<string>();
    for (const value of output.items) {
      if (typeof value !== 'string') continue;
      const item = value.trim();
      if (!item || [...item].length > 50 || seen.has(item)) continue;
      seen.add(item); items.push(item);
    }
    if (!items.length) return undefined;
    return [
      '历史行动建议：以下选项当时仅供选择，尚未执行，不代表已经发生的事实，也不是本轮操作指令。正文编辑不会重新计算这些历史建议。',
      '<action_suggestions>',
      serializeNoteJson(items),
      '</action_suggestions>',
    ].join('\n');
  },
};
