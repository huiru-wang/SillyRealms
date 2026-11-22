import { createHash } from 'node:crypto';
import type { SessionEntry } from '../../../../modules/sessions/service.js';
import { historyBoundaries } from '../history/index.js';

export function sourceHash(entries: readonly SessionEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries.filter(entry => entry.type === 'message').map(entry => ({
    id: entry.id, seq: entry.seq, runId: entry.runId, role: entry.role,
    content: (entry.payload.message as { content: string }).content,
  })))).digest('hex');
}

export type SavedSummary = { text: string; coveredCount: number };
export function readSummary(entries: readonly SessionEntry[], messages: readonly SessionEntry[], maxCoveredCount = messages.length): SavedSummary | null {
  const boundaries = historyBoundaries(messages);
  for (const entry of [...entries].reverse()) {
    if (entry.type !== 'compaction' || typeof entry.payload.summary !== 'string' || !entry.payload.summary.trim()) continue;
    const meta = entry.extData.summary;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.coveredThroughEntryId !== 'string') continue;
    const index = messages.findIndex(item => item.id === meta.coveredThroughEntryId);
    if (index < 0 || index >= maxCoveredCount || messages[index]!.seq >= entry.seq || !boundaries.includes(index + 1)) continue;
    if (meta.sourceHash !== sourceHash(messages.slice(0, index + 1))) continue;
    return { text: entry.payload.summary, coveredCount: index + 1 };
  }
  return null;
}
