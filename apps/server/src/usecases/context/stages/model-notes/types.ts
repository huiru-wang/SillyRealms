import type { SessionEntry, Capabilities } from '../../../../modules/sessions/service.js';

export type NoteEntry = SessionEntry & { capabilities?: Capabilities };
export type ModelNote = { source: string; content: string };
export type ModelNotes = ReadonlyMap<string, readonly ModelNote[]>;
export type ModelNoteSource = {
  source: string;
  build(entry: Readonly<NoteEntry>): string | undefined;
};
