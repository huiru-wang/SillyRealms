import type { SessionEntry } from '../../../../modules/sessions/service.js';
import { actionSuggestionNotes } from './action-suggestions.js';
import { stateUpdateNotes } from './state-update.js';
import { record } from './serialization.js';
import type { ModelNote, ModelNotes, ModelNoteSource } from './types.js';

export type { ModelNote, ModelNotes, ModelNoteSource } from './types.js';

/** Sources are independent and only create an in-memory projection; history is never rewritten. */
export function buildModelNotes(entries: readonly SessionEntry[], sources: readonly ModelNoteSource[]): ModelNotes {
  const byEntry = new Map<string, readonly ModelNote[]>();
  for (const entry of entries) {
    const notes = new Map<string, ModelNote>();
    for (const source of sources) {
      if (notes.has(source.source)) continue;
      try {
        const content = source.build(entry);
        if (typeof content === 'string' && content.trim()) {
          notes.set(source.source, { source: source.source, content });
        }
      } catch { /* An unavailable source must not discard other notes or prevent context preparation. */ }
    }
    if (notes.size) byEntry.set(entry.id, [...notes.values()]);
  }
  return byEntry;
}

/** Select the most recent visible assistants first; missing output never revives older notes. */
export function buildNarrativeNotes(entries: readonly SessionEntry[]): ModelNotes {
  const recent = entries.filter(entry => {
    if (entry.type !== 'message' || entry.role !== 'assistant') return false;
    const message = record(entry.payload.message);
    return message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim().length > 0;
  }).slice(-2);
  return buildModelNotes(recent, [stateUpdateNotes, actionSuggestionNotes]);
}

/** Only assembly calls this function; activation and summarization keep the original body. */
export function renderModelNotes(body: string, notes: readonly ModelNote[] | undefined): string {
  const content = notes?.map(note => note.content).filter(value => value.trim()) ?? [];
  return content.length ? body + '\n\n<model_notes>\n' + content.join('\n\n') + '\n</model_notes>' : body;
}
