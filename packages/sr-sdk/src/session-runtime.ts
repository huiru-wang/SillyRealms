import type { SRSessionAPI, HistoryRunsResult, RunEvent, SessionRunEvent } from './run-contract.js';
type Transport = {
  send(text: string): Promise<{ runId: string; requestId: string }>;
  history(options?: { cursor?: string; limit?: number }): Promise<HistoryRunsResult>;
  setDraft(text: string): void;
};
/** Creator commands remain on the existing Host transport. Phase events are opt-in. */
export class SessionRuntime implements SRSessionAPI {
  private readonly listeners = new Map<(event: any) => void, boolean>();
  constructor(private readonly transport: Transport) {}
  setDraft(text: string) { this.transport.setDraft(text); }
  send(text: string) { return this.transport.send(text); }
  getHistoryRuns(options?: { cursor?: string; limit?: number }) { return this.transport.history(options); }
  subscribe(listener: (event: RunEvent) => void): () => void;
  subscribe(listener: (event: SessionRunEvent) => void, options: { includePhase: true }): () => void;
  subscribe(listener: (event: any) => void, options?: { includePhase: true }) {
    this.listeners.set(listener, options?.includePhase === true);
    return () => { this.listeners.delete(listener); };
  }
  accept(event: SessionRunEvent) {
    for (const [listener, includePhase] of this.listeners) {
      if (event.event === 'run.phase' && !includePhase) continue;
      try { listener(structuredClone(event)); } catch { /* Listener failures are isolated. */ }
    }
  }
}
