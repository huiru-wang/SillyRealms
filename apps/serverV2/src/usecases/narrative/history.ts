import { createHash } from 'node:crypto';
import { AppError } from '../../errors.js';
import type { SessionEntry } from '../../modules/sessions/service.js';
import type { NarrativeHistoryMessage } from './materials.js';

export function narrativeMessage(entry: SessionEntry): NarrativeHistoryMessage | null {
  if (entry.type === 'compaction') return null;
  const message = entry.payload.message;
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.role !== entry.role ||
    typeof message.content !== 'string' || typeof message.timestamp !== 'number' ||
    !Number.isFinite(message.timestamp) || message.timestamp < 0) throw new AppError('INVALID_NARRATIVE_HISTORY');
  if (entry.role === 'assistant' && !message.content.trim()) return null;
  return { id: entry.id, role: entry.role, text: message.content, timestamp: message.timestamp };
}

export function projectHistory(entries: readonly SessionEntry[]): NarrativeHistoryMessage[] {
  return entries.map(narrativeMessage).filter((item): item is NarrativeHistoryMessage => item !== null);
}

/** Legal prefix lengths: never split a run, including a run interleaved by manual appends. */
export function historyBoundaries(entries: readonly SessionEntry[]): number[] {
  const last = new Map<string, number>();
  entries.forEach((entry, index) => last.set(entry.runId, index));
  const boundaries = [0];
  let end = -1;
  entries.forEach((entry, index) => {
    end = Math.max(end, last.get(entry.runId)!);
    if (index === end) boundaries.push(index + 1);
  });
  return boundaries;
}

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
