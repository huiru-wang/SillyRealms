import type { SessionEntry } from '../../../../modules/sessions/service.js';

export type ModelNote = { source: string; content: string };
export type ModelNotes = ReadonlyMap<string, readonly ModelNote[]>;
export type ModelNoteSource = {
  source: string;
  build(entry: Readonly<SessionEntry>): string | undefined;
};
