/** Public narrative messages omit raw tool entries and implementation metadata. */
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

export type Run = {
  id: string;
  status: 'preparing' | 'running' | 'completed' | 'failed' | 'stopped';
  messages: ChatMessage[];
};

export type RunEvent =
  | { event: 'run.created'; data: { runId: string; messages: ChatMessage[] } }
  | { event: 'run.delta'; data: { runId: string; messageId: string; text: string } }
  | { event: 'run.completed'; data: { runId: string; messages: ChatMessage[] } }
  | { event: 'run.failed'; data: { runId: string; messages: ChatMessage[]; errorCode: string; errorMessage: string } }
  | { event: 'run.stopped'; data: { runId: string; messages: ChatMessage[] } };

export type HistoryRunsResult = {
  runs: Run[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** Target contract; runtime integration is not yet complete. */
export interface SRSessionAPI {
  setDraft(text: string): void;
  send(text: string): Promise<{ runId: string; requestId: string }>;
  getHistoryRuns(options?: { cursor?: string; limit?: number }): Promise<HistoryRunsResult>;
  subscribe(listener: (event: RunEvent) => void): () => void;
}
