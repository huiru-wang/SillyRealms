import { parseRoleplay } from '@sillyrealms/roleplay';
import { AppError } from '../../../../errors.js';
import type { ModelInfo, ModelMessage } from '../../../../infrastructure/model/client.js';
import type { NarrativeHistoryMessage } from '../history/index.js';
import { estimateInputTokens } from '../../lib/estimate.js';
import { summaryBudget } from '../../lib/budget.js';

/** Instructions are player controls, not story facts. Preserve their line boundaries only. */
export function summaryNarrative(text: string, role: 'user' | 'assistant'): string {
  const ranges = parseRoleplay(text, role).ranges.filter(range => range.kind === 'instruction');
  return ranges.reduceRight((value, range) => value.slice(0, range.start) +
    value.slice(range.start, range.end).replace(/[^\r\n]/gu, ' ') + value.slice(range.end), text);
}

export function summaryRequest(model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>, prompt: string, previousSummary: string, history: readonly NarrativeHistoryMessage[]) {
  const budget = summaryBudget(model);
  const messages: ModelMessage[] = [
    { role: 'system', content: prompt, timestamp: 0 },
    { role: 'user', content: JSON.stringify({ previousSummary, messages: history.map(item => ({
      role: item.role, content: summaryNarrative(item.text, item.role),
    })) }), timestamp: 0 },
  ];
  if (estimateInputTokens(messages) > budget.inputBudget) throw new AppError('SUMMARY_CAPACITY_EXCEEDED');
  return { messages, maxTokens: budget.maxTokens };
}
