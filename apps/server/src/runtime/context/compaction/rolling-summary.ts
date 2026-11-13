import { historyFingerprint, type HistoryItem } from './history.js';
import { selectSuffix } from './sliding-window.js';
import type { CompactionInput } from './types.js';
export async function rollingSummary(input: CompactionInput, history: HistoryItem[], allowance: number) {
  const selection = selectSuffix(history, allowance, input.policy.keepRecentTurns);
  if (!selection.prefix.length) return undefined;
  const text = await input.summarize(input.oldSummary?.text ?? null, selection.prefix);
  return { ...selection, summary: { text, coveredThroughEntryId: selection.prefix.at(-1)!.id,
    firstKeptEntryId: selection.kept[0]?.id, sourceFingerprint: historyFingerprint(input.history),
    gaps: [...new Set([...(input.oldSummary?.gaps ?? []), ...selection.prefix.flatMap(item => item.gap ? [item.gap] : [])])].slice(-32) } };
}
