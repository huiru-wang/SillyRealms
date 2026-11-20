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
export function readSummary(entries: readonly SessionEntry[], messages: readonly SessionEntry[]): SavedSummary | null {
  const entry = [...entries].reverse().find(item => item.type === 'compaction');
  if (!entry || typeof entry.payload.summary !== 'string' || !entry.payload.summary.trim()) return null;
  const meta = entry.extData.summary;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.coveredThroughEntryId !== 'string') return null;
  const index = messages.findIndex(item => item.id === meta.coveredThroughEntryId);
  if (index < 0 || messages[index]!.seq >= entry.seq || !historyBoundaries(messages).includes(index + 1)) return null;
  if (meta.sourceHash !== sourceHash(messages.slice(0, index + 1))) return null;
  return { text: entry.payload.summary, coveredCount: index + 1 };
}
