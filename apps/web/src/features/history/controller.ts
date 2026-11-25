import {errorKey} from '../../i18n/errors.ts';
import type {AcceptedRun, Entry, StoredRun, RunPage, RunQuery, StageMessage, StageRun, ToolCall} from '../../../../../packages/sr-sdk/src/stage-contract.ts';
import type {HttpRequest} from '../../transport/http.ts';

export type HistorySnapshot = {
  runs: StoredRun[];
  activeRunId: string | null;
  afterSeq: number;
  nextCursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
};
type Options = {sessionId: string; request: HttpRequest};
const terminal = (status: StoredRun['status']) => status === 'completed' || status === 'stopped';
const errorText = (error: unknown) => errorKey(error,"sessions:historyFailed");

function entryMessage(entry: Entry): StageMessage | null {
  if (entry.type !== 'message' || (entry.role !== 'user' && entry.role !== 'assistant')) return null;
  const message = entry.payload.message as Record<string, unknown> | undefined;
  if (!message || typeof message.content !== 'string') return null;
  return {
    id: entry.id, runId: entry.runId, role: entry.role, content: message.content,
    timestamp: entry.timestamp, seq: entry.seq, saved: true,
    ...(typeof message.reasoning_content === 'string' ? {reasoning_content: message.reasoning_content} : {}),
    ...(Array.isArray(message.tool_calls) ? {tool_calls: structuredClone(message.tool_calls) as ToolCall[]} : {}),
    ...(entry.extData.output && typeof entry.extData.output === 'object' && !Array.isArray(entry.extData.output)
      ? {output: structuredClone(entry.extData.output) as Record<string, unknown>} : {}),
  };
}

export function projectRun(run: StoredRun): StageRun {
  return {runId: run.runId, assistantEntryId: run.assistantEntryId, status: run.status,
    messages: run.entries.flatMap(entry => { const message = entryMessage(entry); return message ? [message] : []; }),
    ...(run.stopReason === undefined ? {} : {stopReason: run.stopReason}),
    ...(run.finishedAt === undefined ? {} : {finishedAt: run.finishedAt})};
}

/** The sole owner of persisted entries. Temporary model messages never enter this store. */
export function createHistoryController({sessionId, request}: Options) {
  const runs = new Map<string, StoredRun>();
  const listeners = new Set<() => void>(), pending = new Set<AbortController>();
  let disposed = false, initialized = false, recentVersion = 0, olderVersion = 0, epoch = 0;
  let snapshot: HistorySnapshot = {
    runs: [], activeRunId: null, afterSeq: 0,
    nextCursor: null, hasMore: false, loading: false, loadingMore: false, error: null,
  };
  const base = 'v1/sessions/' + encodeURIComponent(sessionId);
  const emit = (patch: Partial<HistorySnapshot> = {}) => {
    if (disposed) return;
    snapshot = {...snapshot, ...patch};
    for (const listener of listeners) try { listener(); } catch { /* Isolate observers. */ }
  };
  const ingestPage = (page: RunPage) => {
    for (const incoming of page.items) {
      const previous = runs.get(incoming.runId);
      // Pages contain whole runs. Overlapping reads may return an older revision.
      if (previous && (previous.lastSeq > incoming.lastSeq || (terminal(previous.status) && !terminal(incoming.status)))) continue;
      runs.set(incoming.runId, incoming);
    }
    return [...runs.values()].sort((a, b) => a.firstSeq - b.firstSeq);
  };
  const call = async <T,>(path: string, signal?: AbortSignal): Promise<T> => {
    if (disposed) throw new DOMException('History controller disposed', 'AbortError');
    const controller = new AbortController(); pending.add(controller);
    try {
      const result = await request<T>(path, {signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal});
      if (disposed) throw new DOMException('History controller disposed', 'AbortError');
      return result;
    } finally { pending.delete(controller); }
  };
  const query = (options: RunQuery = {}, signal?: AbortSignal): Promise<RunPage> => {
    const params = new URLSearchParams();
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    if (options.afterSeq !== undefined) params.set('afterSeq', String(options.afterSeq));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    return call<RunPage>(base + '/narrative/runs' + (params.size ? '?' + params.toString() : ''), signal);
  };
  const activeFrom = (page: RunPage) => {
    const id = page.activeRunId;
    return id && !terminal(runs.get(id)?.status ?? 'unknown') ? id : null;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    query,
    acceptExecution(accepted: Pick<AcceptedRun, 'runId' | 'assistantEntryId' | 'deletedMessageIds'>) {
      const previous = runs.get(accepted.runId);
      if (previous?.assistantEntryId === accepted.assistantEntryId && !accepted.deletedMessageIds.some(id => previous.entries.some(entry => entry.id === id))) return;
      epoch++; recentVersion++; olderVersion++;
      if (previous) {
        const entries = previous.entries.filter(entry => !accepted.deletedMessageIds.includes(entry.id));
        runs.set(previous.runId, {...previous, entries, assistantEntryId: accepted.assistantEntryId,
          status: 'running', finishedAt: undefined, stopReason: undefined, lastSeq: entries.at(-1)?.seq ?? previous.firstSeq});
      }
      const ordered = [...runs.values()].sort((a,b) => a.firstSeq-b.firstSeq);
      emit({runs: ordered, activeRunId: accepted.runId, afterSeq: ordered.at(-1)?.lastSeq ?? 0, loading: false, loadingMore: false});
    },
    async loadRecent(reset = false) {
      if (reset) { epoch++; olderVersion++; }

      const version = ++recentVersion;
      emit({loading: true, error: null});
      try {
        const page = await query();
        if (version !== recentVersion || disposed) return page;
        if (reset) { runs.clear(); initialized = false; }
        const ordered = ingestPage(page);
        const pagination = initialized ? {} : {nextCursor: page.nextCursor, hasMore: page.hasMore};
        initialized = true;
        emit({...pagination, runs: ordered, loading: false, activeRunId: activeFrom(page), afterSeq: reset ? page.nextAfterSeq ?? 0 : Math.max(snapshot.afterSeq, page.nextAfterSeq ?? 0)});
        return page;
      } catch (error) {
        if (!disposed && version === recentVersion) emit({loading: false, error: errorText(error)});
        throw error;
      }
    },
    async loadOlder() {
      if (snapshot.loadingMore || !snapshot.hasMore || !snapshot.nextCursor) return null;
      const version = ++olderVersion, cursor = snapshot.nextCursor;
      emit({loadingMore: true, error: null});
      try {
        const page = await query({cursor});
        if (version !== olderVersion || disposed) return page;
        const ordered = ingestPage(page);
        emit({runs: ordered, loadingMore: false, nextCursor: page.nextCursor, hasMore: page.hasMore});
        return page;
      } catch (error) {
        if (!disposed && version === olderVersion) emit({loadingMore: false, error: errorText(error)});
        throw error;
      }
    },
    /** All forward pages are consumed; an empty page never resets the checkpoint. */
    async catchUp() {
      const checkpoint = epoch;
      // A run may acquire only a terminal outcome, without appending another seq.
      const latest = snapshot.runs.at(-1);
      let afterSeq = latest && !terminal(latest.status)
        ? Math.min(snapshot.afterSeq, latest.lastSeq - 1) : snapshot.afterSeq;
      let last: RunPage | null = null;
      try {
        while (!disposed) {
          const page = await query({afterSeq}); last = page;
          if (checkpoint !== epoch || disposed) return page;
          const ordered = ingestPage(page);
          const next = page.nextAfterSeq;
          emit({runs: ordered, activeRunId: activeFrom(page), afterSeq: Math.max(snapshot.afterSeq, next ?? afterSeq), error: null});
          if (!page.hasMore) return page;
          if (next === null || next <= afterSeq) throw new Error("sessions:historyCursorStalled");
          afterSeq = next;
        }
        return last;
      } catch (error) {
        if (!disposed && checkpoint === epoch) emit({error: errorText(error)});
        throw error;
      }
    },
    dispose() {
      disposed = true; recentVersion++; olderVersion++;
      for (const controller of pending) controller.abort();
      pending.clear(); listeners.clear();
    },
  };
}
export type HistoryController = ReturnType<typeof createHistoryController>;
