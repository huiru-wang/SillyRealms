import type {
  ModelDelta, ModelFinishReason, ModelSnapshot,
} from '../../infrastructure/model/client.js';

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

export type NarrativeStopReason =
  | 'cancelled' | 'server_shutdown' | 'provider_aborted' | 'provider_error'
  | 'provider_context_window_exceeded' | 'model_not_found' | 'model_capability_unsupported'
  | 'credential_not_configured' | 'credential_unavailable' | 'context_budget_exceeded'
  | 'invalid_context' | 'output_incomplete' | 'model_output_invalid'
  | 'tool_execution_unsupported' | 'message_persist_failed' | 'tip_conflict'
  | 'session_deleted' | 'internal_error';

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

type StateValue = null | boolean | number | string | StateValue[] | { [key: string]: StateValue };
type StateScope = { scope: 'global' | 'session'; messageId?: never } | { scope: 'message'; messageId: string };

/** Reserved wire shapes only: no tools, state writes or suggestions are executed in this version. */
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
  | { event: 'state.changed'; data: { sessionId: string } & StateScope & { changes: { path: string; value: StateValue }[] } }
  | { event: 'action_suggestions.changed'; data: { sessionId: string; runId: string; messageId: string; items: string[] } };
