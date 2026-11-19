import type { ErrorCode } from '../../errors.js';

type RunMessages = { runId: string; userEntryId: string; assistantEntryId: string };
type SavedRun = {
  runId: string;
  userEntryId: string;
  /** Null when there was no body or the assistant write failed. */
  assistantEntryId: string | null;
  tipEntryId: string | null;
};

export type NarrativeEvent =
  | { event: 'run.started'; data: RunMessages }
  | { event: 'message.delta'; data: { runId: string; messageId: string; offset: number; text: string } }
  | { event: 'run.completed'; data: SavedRun & { assistantEntryId: string } }
  | { event: 'run.failed'; data: SavedRun & { errorCode: ErrorCode; errorMessage: string } }
  | { event: 'run.stopped'; data: SavedRun };

export type NarrativeTerminalEvent = Extract<NarrativeEvent, { event: 'run.completed' | 'run.failed' | 'run.stopped' }>;
