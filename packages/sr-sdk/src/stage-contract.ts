/** ServerV2 wire contracts and the read-only projection consumed by its isolated stage.
 * Kept separate from the original Studio contract; no legacy run states are inferred.
 */
import type {StateScope, StateValue, StateWriteResult} from './state-contract.js';
export type {StateScope, StateValue, StateWriteResult} from './state-contract.js';

export type StateSnapshot = Record<StateScope, Record<string, StateValue>>;
export type StateWrite = {path: string; value: StateValue; scope?: StateScope};
export type ToolCall = {index: number; id: string; type: 'function'; function: {name: string; arguments: string}};
export type MessageSnapshot = {role: 'assistant'; content: string; reasoning_content: string; tool_calls: ToolCall[]};
export type MessageDelta = {content?: string; reasoning_content?: string; tool_calls?: Array<{
  index: number; id?: string; type?: 'function'; function?: {name?: string; arguments?: string};
}>};
export type AcceptedRun = {runId: string; userEntryId: string; assistantEntryId: string};
export type RunStatus = 'running' | 'stopping' | 'completed' | 'stopped' | 'unknown';
export type RunPhase = 'preparing' | 'summarizing' | 'generating';
export type Usage = {input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens: number; cache_write_tokens: number};
export type Entry = {
  id: string; sessionId: string; parentId: string | null; runId: string; seq: number;
  type: 'message' | 'compaction'; role: 'user' | 'assistant' | null; timestamp: number;
  payload: Record<string, unknown>; state: StateValue[] | null; extData: Record<string, unknown>;
  metrics: unknown; createdAt: number; updatedAt: number;
};
export type StoredRun = {
  runId: string; firstSeq: number; lastSeq: number; entries: Entry[]; status: RunStatus;
  stopReason?: string; finishedAt?: number;
};
export type RunPage = {
  items: StoredRun[]; hasMore: boolean; nextCursor: string | null; nextAfterSeq: number | null; activeRunId: string | null;
};
export type RunQuery = {cursor?: string; afterSeq?: number; limit?: 5};
export type EventFields = {runId: string; sessionId: string; provider: string | null; model: string | null; timestamp: number};
export type SavedRunFields = EventFields & {savedMessageIds: string[]; tipEntryId: string | null};
export type NarrativeEvent =
  | {event: 'run.created'; data: EventFields & {messages: [{id: string; role: 'user'; content: string; timestamp: number}]}}
  | {event: 'run.summarizing'; data: EventFields}
  | {event: 'run.summarized'; data: EventFields & {entryId: string}}
  | {event: 'run.delta'; data: EventFields & {messageId: string; messages: [{role: 'assistant'; delta: MessageDelta; snapshot?: MessageSnapshot; finish_reason?: 'stop' | 'length' | 'tool_calls' | 'deferred'}]}}
  | {event: 'run.usage'; data: EventFields & {usage: Usage | null}}
  | {event: 'run.completed'; data: SavedRunFields}
  | {event: 'run.stopped'; data: SavedRunFields & {stop_reason: string}};
export type StateChangedEvent = {event: 'state.changed'; data: {path: string; scope: StateScope; value: StateValue}};
export type Suggestions = {runId: string; messageId: string; items: string[]};
export type SuggestionsCreatedEvent = {event: 'action_suggestions.created'; data: Suggestions & {sessionId: string}};
export type SessionEvent = NarrativeEvent | StateChangedEvent | SuggestionsCreatedEvent |
  {event: 'session.created'; data: {sessionId: string; tipEntryId: string; timestamp: number; entry: Entry}};

/** Presentation-only fields: saved is confirmed by persisted entries, never by model finish. */
export type StageMessage = {
  id: string; runId: string; role: 'user' | 'assistant'; content: string;
  reasoning_content?: string; tool_calls?: ToolCall[]; timestamp: number; seq?: number; saved: boolean;
  output?: Record<string, unknown>;
};
export type StageRun = {
  runId: string; status: RunStatus; phase?: RunPhase; messages: StageMessage[];
  stopReason?: string; finishedAt?: number;
};
export type StageSnapshot = {
  sessionId: string; connected: boolean; activeRunId: string | null; runs: StageRun[]; streamIncomplete?: boolean;
  suggestions: Suggestions | null;
  history: {loading: boolean; loadingMore: boolean; hasMore: boolean; error: string | null};
  state: StateSnapshot; stateLoading: boolean; stateError: string | null;
};
export type StageCommandMap = {
  'narrative.send': {input: {text: string}; output: AcceptedRun};
  'narrative.stop': {input: {runId: string}; output: {runId: string; stopping: true}};
  'history.loadMore': {input: Record<string, never>; output: void};
  'history.refresh': {input: Record<string, never>; output: void};
  'history.query': {input: RunQuery; output: RunPage};
  'state.read': {input: Record<string, never>; output: StateSnapshot};
  'state.write': {input: {updates: StateWrite[]}; output: StateWriteResult[]};
  'composer.setDraft': {input: {text: string}; output: void};
};
export type StageCommand = <K extends keyof StageCommandMap>(method: K, input: StageCommandMap[K]['input']) => Promise<StageCommandMap[K]['output']>;
