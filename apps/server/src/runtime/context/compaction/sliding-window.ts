import { estimateHistory } from './estimator.js';
import { historyGroups, type HistoryItem } from './history.js';
/** A fixed non-history reserve makes suffix selection deterministic and linear. */
export function selectSuffix(history: HistoryItem[], allowance: number, protectTurns = 0): {
  kept: HistoryItem[]; prefix: HistoryItem[]; omittedTurnCount: number;
} {
  const groups = historyGroups(history);
  let start = groups.length, used = 0, protectedCount = 0;
  while (start > 0) {
    const group = groups[start - 1]!, cost = estimateHistory(group);
    const mustKeep = protectedCount < protectTurns && group[0]!.role === 'user';
    if (!mustKeep && used + cost > allowance) break;
    used += cost; start--;
    if (group[0]!.role === 'user') protectedCount++;
  }
  return { kept: groups.slice(start).flat(), prefix: groups.slice(0, start).flat(), omittedTurnCount: groups.slice(0, start).filter(g => g[0]!.role === 'user').length };
}
