import type { NarrativeStopReason } from '../../modules/sessions/service.js';
import type {
  ModelDelta, ModelFinishReason, ModelSnapshot,
} from '../../infrastructure/model/client.js';
import type { StateEvent } from '../../modules/state/service.js';

export type RunEventFields = {
  runId: string;
  sessionId: string;
  provider: string | null;
  model: string | null;
  timestamp: number;
};

export type SavedUserMessage = { id: string; role: 'user'; content: string; timestamp: number };
export type AssistantDeltaMessage = {
  role: 'assistant';
  delta: Omit<ModelDelta, 'role'>;
  /** Finishes this model message, not the run or its persistence. */
  finish_reason?: ModelFinishReason;
  /** Replaces all public message fields rather than appending them. */
  snapshot?: ModelSnapshot;
};

export type { NarrativeStopReason } from '../../modules/sessions/service.js';

export type NarrativeUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

type SavedRun = RunEventFields & {
  /** Entries from this run that still exist after settlement. */
  savedMessageIds: string[];
  tipEntryId: string | null;
};

/** Events produced by the current single-request narrative implementation. */
export type NarrativeEvent =
  | { event: 'run.created'; data: RunEventFields & { messages: [SavedUserMessage] } }
  | { event: 'run.delta'; data: RunEventFields & { messageId: string; messages: [AssistantDeltaMessage] } }
  | { event: 'run.usage'; data: RunEventFields & { usage: NarrativeUsage | null } }
  | { event: 'run.completed'; data: SavedRun }
  | { event: 'run.stopped'; data: SavedRun & { stop_reason: NarrativeStopReason } };

export type NarrativeTerminalEvent = Extract<NarrativeEvent, { event: 'run.completed' | 'run.stopped' }>;
export type NarrativeSettlement = {
  usage: Extract<NarrativeEvent, { event: 'run.usage' }>;
  terminal: NarrativeTerminalEvent;
};

/** Reserved wire shapes only; narrative tools, state updates and suggestions are not produced. */
export type ReservedNarrativeEvent =
  | { event: 'run.delta'; data: RunEventFields & {
    messageId: string; messages: [{ role: 'system'; delta: { content: string } }];
  } }
  | { event: 'run.delta'; data: RunEventFields & {
    messageId: string; messages: [{
      role: 'tool';
      delta: { tool_call_id: string; name: string; status: string; content: string; is_error: boolean };
    }];
  } }
  | StateEvent
  | { event: 'action_suggestions.changed'; data: { sessionId: string; runId: string; messageId: string; items: string[] } };
