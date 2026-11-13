import { parseRoleplay } from '@sillyrealms/roleplay';
import { fingerprint } from '../../config.js';

export type HistoryItem = { id: string; role: 'user' | 'assistant'; text: string; gap?: string };
/** Opening assistant content is its own earliest group; subsequent groups are complete user turns. */
export function historyGroups(history: HistoryItem[]): HistoryItem[][] {
  const groups: HistoryItem[][] = [];
  for (const item of history) {
    if (item.role === 'user' || !groups.length) groups.push([]);
    groups[groups.length - 1]!.push(item);
  }
  return groups;
}
export function historyFingerprint(history: HistoryItem[]): string { return fingerprint(history.map(({ id, role, text }) => ({ id, role, text }))); }
/** Instructions are not story facts. Keep line/offset shape without sending instruction text. */
export function summaryNarrative(text: string, role: 'user' | 'assistant'): string {
  const ranges = parseRoleplay(text, role).ranges.filter(range => range.kind === 'instruction');
  return ranges.reduceRight((value, range) => value.slice(0, range.start) +
    value.slice(range.start, range.end).replace(/[^\r\n]/gu, ' ') + value.slice(range.end), text);
}
