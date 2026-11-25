import type {SessionEvent, StoredRun, Suggestions} from '../../../../../packages/sr-sdk/src/stage-contract.ts';

export type SuggestionsSnapshot = {
  currentRunId: string | null;
  suggestions: Suggestions | null;
  revision: number;
};

function savedSuggestions(run: StoredRun | null): Suggestions | null {
  if (!run || run.status !== 'completed') return null;
  const entry = [...run.entries].reverse().find(item => item.type === 'message');
  if (entry?.role !== 'assistant') return null;
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
  const begin = (runId: string, executionId: string) => {
    if (disposed || snapshot.currentRunId === runId && assistantEntryId === executionId) return;
    assistantEntryId = executionId;
    update(runId, null);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Capture before an async query and pass it back to restore. */
    checkpoint: () => snapshot.revision,
    restore(run: StoredRun | null, checkpoint: number) {
      if (disposed || checkpoint !== snapshot.revision) return false;
      const restored = savedSuggestions(run);
      assistantEntryId = run?.assistantEntryId ?? restored?.messageId ?? null;
      update(run?.runId ?? null, restored);
      return true;
    },
    accept(event: SessionEvent) {
      if (disposed || !('sessionId' in event.data) || event.data.sessionId !== sessionId) return;
      if (event.event === 'message.deleted' || event.event === 'run.created') {
        begin(event.data.runId, event.data.assistantEntryId);
      } else if (event.event === 'action_suggestions.created') {
        if (snapshot.currentRunId !== null && snapshot.currentRunId !== event.data.runId) return;
        if (assistantEntryId && assistantEntryId !== event.data.messageId) return;
        const items = event.data.items.filter(item => typeof item === 'string' && !!item.trim());
        assistantEntryId = event.data.messageId;
        update(event.data.runId, items.length ? {runId: event.data.runId, messageId: event.data.messageId, items: [...items]} : null);
      }
    },
    begin,
    clear() { if (!disposed) { assistantEntryId = null; update(null, null); } },
    dispose() { disposed = true; listeners.clear(); },
  };
}
export type SuggestionsController = ReturnType<typeof createSuggestionsController>;
