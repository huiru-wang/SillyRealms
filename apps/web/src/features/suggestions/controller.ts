import type {SessionEvent, StoredRun, Suggestions} from '../../../../../packages/sr-sdk/src/stage-contract.ts';

export type SuggestionsSnapshot = {
  currentRunId: string | null;
  suggestions: Suggestions | null;
  revision: number;
};

function savedSuggestions(run: StoredRun | null): Suggestions | null {
  if (!run || run.status !== 'completed') return null;
  const entry = [...run.entries].reverse().find(item => item.type === 'message' && item.role === 'assistant');
  const output = entry?.extData.output as {actionSuggestions?: {status?: string; items?: unknown}} | undefined;
  const result = output?.actionSuggestions;
  if (!entry || !result || !['success', 'partial_success'].includes(result.status ?? '') || !Array.isArray(result.items)) return null;
  const items = result.items.filter((item): item is string => typeof item === 'string' && !!item.trim());
  return items.length ? {runId: run.runId, messageId: entry.id, items: [...items]} : null;
}

/** Current suggestions are a projection, not another persisted history store. */
export function createSuggestionsController(sessionId: string) {
  let snapshot: SuggestionsSnapshot = {currentRunId: null, suggestions: null, revision: 0};
  let disposed = false, assistantEntryId: string | null = null;
  const listeners = new Set<() => void>();
  const update = (runId: string | null, suggestions: Suggestions | null) => {
    snapshot = {currentRunId: runId, suggestions, revision: snapshot.revision + 1};
    for (const listener of listeners) try { listener(); } catch { /* Isolate observers. */ }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Capture before an async query and pass it back to restore. */
    checkpoint: () => snapshot.revision,
    restore(run: StoredRun | null, checkpoint: number) {
      if (disposed || checkpoint !== snapshot.revision) return false;
      assistantEntryId = run?.assistantEntryId ?? null;
      update(run?.runId ?? null, savedSuggestions(run));
      return true;
    },
    accept(event: SessionEvent) {
      if (disposed || !('sessionId' in event.data) || event.data.sessionId !== sessionId) return;
      if (event.event === 'message.deleted') {
        assistantEntryId = event.data.assistantEntryId; update(event.data.runId, null);
      } else if (event.event === 'run.created') {
        assistantEntryId = event.data.assistantEntryId;
        update(event.data.runId, null);
      } else if (event.event === 'action_suggestions.created') {
        if (snapshot.currentRunId !== null && snapshot.currentRunId !== event.data.runId) return;
        if (assistantEntryId && assistantEntryId !== event.data.messageId) return;
        const items = event.data.items.filter(item => typeof item === 'string' && !!item.trim());
        if (items.length) update(event.data.runId, {runId: event.data.runId, messageId: event.data.messageId, items: [...items]});
      }
    },
    begin(runId: string, executionId: string) { if (!disposed) { assistantEntryId = executionId; update(runId, null); } },
    clear() { if (!disposed) update(null, null); },
    dispose() { disposed = true; listeners.clear(); },
  };
}
export type SuggestionsController = ReturnType<typeof createSuggestionsController>;
