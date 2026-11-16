/** Public narrative messages omit raw tool entries and implementation metadata. */
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; origin?: 'opening' };
export type RunPhase = 'preparing' | 'narrative' | 'extensions' | 'finalized';
export type StateUpdateResult = {
  status: 'disabled' | 'not_required' | 'pending' | 'unchanged' | 'applied' | 'partial' | 'failed' | 'cancelled';
};
export type ActionSuggestionsResult = {
  status: 'disabled' | 'pending' | 'ready' | 'blocked' | 'failed' | 'cancelled';
};
export type RunExtensions = {stateUpdate: StateUpdateResult; actionSuggestions: ActionSuggestionsResult};
export type RunMetadata = {phase?: RunPhase; extensions?: RunExtensions};
export type Run = RunMetadata & {
  id: string; status: 'preparing' | 'running' | 'completed' | 'failed' | 'stopped'; messages: ChatMessage[];
};
export type RunEvent =
  | { event: 'run.snapshot'; data: RunMetadata & { runId: string; status: Run['status']; messages: ChatMessage[] } }
  | { event: 'run.created'; data: RunMetadata & { runId: string; messages: ChatMessage[] } }
  | { event: 'run.delta'; data: { runId: string; messageId: string; text: string; offset?: number } }
  | { event: 'run.completed'; data: RunMetadata & { runId: string; messages: ChatMessage[] } }
  | { event: 'run.failed'; data: RunMetadata & { runId: string; messages: ChatMessage[]; errorCode: string; errorMessage: string } }
  | { event: 'run.stopped'; data: RunMetadata & { runId: string; messages: ChatMessage[] } };
export type RunPhaseEvent = { event: 'run.phase'; data: { runId: string; phase: RunPhase } };
export type ActionSuggestions = {runId:string;messageId:string;items:string[]};
export type ActionSuggestionsEvent = {event:'action_suggestions.changed';data:{sessionId:string;suggestions:ActionSuggestions|null}};
export type ConnectionEvent = {event:'session.connection';data:{connected:boolean}};
export type SessionRunEvent = RunEvent | RunPhaseEvent | ActionSuggestionsEvent | ConnectionEvent;
export type HistoryRunsResult = { runs: Run[]; nextCursor: string | null; hasMore: boolean };
export interface SRSessionAPI {
  setDraft(text: string): void;
  send(text: string): Promise<{ runId: string; requestId: string }>;
  getHistoryRuns(options?: { cursor?: string; limit?: number }): Promise<HistoryRunsResult>;
  subscribe(listener: (event: Exclude<SessionRunEvent,RunPhaseEvent>) => void): () => void;
  subscribe(listener: (event: SessionRunEvent) => void, options: { includePhase: true }): () => void;
}
