import type { StateEvent } from '../../modules/state/service.js';
import type { CharacterSpriteOutput, NarrativeStopReason, RunUsage } from '../../modules/sessions/service.js';
import type {
  ModelDelta, ModelFinishReason, ModelSnapshot,
} from '../../infrastructure/model/client.js';

export type RunEventFields = {
  runId: string;
  assistantEntryId: string;
  sessionId: string;
  provider: string | null;
  model: string | null;
  timestamp: number;
};

export type SavedUserMessage = { id: string; role: 'user'; status: 'complete'; content: string; timestamp: number };
export type AssistantDeltaMessage = {
  role: 'assistant';
  delta: Omit<ModelDelta, 'role'>;
  /** Finishes this model message, not the run or its persistence. */
  finish_reason?: ModelFinishReason;
  /** Replaces all public message fields rather than appending them. */
  snapshot?: ModelSnapshot;
};

export type { NarrativeStopReason } from '../../modules/sessions/service.js';

type SavedRun = RunEventFields & {
  /** Entries from this run that still exist after settlement. */
  savedMessageIds: string[];
  tipEntryId: string | null;
};

/** Events produced by the narrative execution. */
export type NarrativeEvent =
  | { event: 'run.created'; data: RunEventFields & { messages: [SavedUserMessage]; tipEntryId: string | null; deletedMessageIds: string[] } }
  | { event: 'run.summarizing'; data: RunEventFields }
  | { event: 'run.summarized'; data: RunEventFields & { entryId: string } }
  | { event: 'run.delta'; data: RunEventFields & { messageId: string; messages: [AssistantDeltaMessage] } }
  | { event: 'run.usage'; data: RunEventFields & { usage: RunUsage } }
  | { event: 'run.completed'; data: SavedRun }
  | { event: 'run.stopped'; data: SavedRun & { stop_reason: NarrativeStopReason } };

export type NarrativeTerminalEvent = Extract<NarrativeEvent, { event: 'run.completed' | 'run.stopped' }>;
export type ActionSuggestionsCreated = {
  event: 'action_suggestions.created';
  data: { sessionId: string; runId: string; messageId: string; items: string[] };
};
export type CharacterSpriteChangedEvent = {
  event: 'character_sprite.changed';
  data: { sessionId: string; runId: string; messageId: string; items: CharacterSpriteOutput['items'] };
};
export type NarrativeSettlement = {
  notifications: (StateEvent | ActionSuggestionsCreated | CharacterSpriteChangedEvent)[];
  usage: Extract<NarrativeEvent, { event: 'run.usage' }>;
  terminal: NarrativeTerminalEvent;
};

/** Reserved wire shapes only; narrative tools are not produced. */
export type ReservedNarrativeEvent =
  | { event: 'run.delta'; data: RunEventFields & {
    messageId: string; messages: [{ role: 'system'; delta: { content: string } }];
  } }
  | { event: 'run.delta'; data: RunEventFields & {
    messageId: string; messages: [{
      role: 'tool';
      delta: { tool_call_id: string; name: string; status: string; content: string; is_error: boolean };
    }];
  } };

export type MessageDeletedEvent = { event: 'message.deleted'; data: { sessionId: string; runId: string; assistantEntryId: string; messageId: string; tipEntryId: string | null } };
