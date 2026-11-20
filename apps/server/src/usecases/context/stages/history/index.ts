import { AppError } from '../../../../errors.js';
import type { SessionEntry } from '../../../../modules/sessions/service.js';

/** Visible body projection only; reasoning and tool requests are not history input. */
export type NarrativeHistoryMessage = { id: string; role: 'user' | 'assistant'; text: string; timestamp: number };

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
