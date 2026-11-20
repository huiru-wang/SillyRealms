import type {Entry, StoredRun, RunPage, RunQuery, StageMessage, StageRun, ToolCall} from '../../../../../packages/sr-sdk/src/stage-contract.ts';
import type {HttpRequest} from '../../transport/http.ts';

export type HistorySnapshot = {
  runs: StoredRun[];
  entries: Entry[];
  messages: StageMessage[];
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
const errorText = (error: unknown) => error instanceof Error ? error.message : '无法读取历史记录';

export function entryMessage(entry: Entry): StageMessage | null {
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

export const projectEntry = entryMessage;
export function projectRun(run: StoredRun): StageRun {
  return {runId: run.runId, status: run.status,
    messages: run.entries.flatMap(entry => { const message = entryMessage(entry); return message ? [message] : []; }),
    ...(run.stopReason === undefined ? {} : {stopReason: run.stopReason}),
    ...(run.finishedAt === undefined ? {} : {finishedAt: run.finishedAt})};
}

/** The sole owner of persisted entries. Temporary model messages never enter this store. */
export function createHistoryController({sessionId, request}: Options) {
  const entries = new Map<string, Entry>();
  const runs = new Map<string, Omit<StoredRun, 'entries'>>();
  const listeners = new Set<() => void>(), pending = new Set<AbortController>();
  let disposed = false, initialized = false, recentVersion = 0, olderVersion = 0;
  let snapshot: HistorySnapshot = {
    runs: [], entries: [], messages: [], activeRunId: null, afterSeq: 0,
    nextCursor: null, hasMore: false, loading: false, loadingMore: false, error: null,
  };
  const base = 'v1/sessions/' + encodeURIComponent(sessionId);
  const emit = (patch: Partial<HistorySnapshot> = {}) => {
    if (disposed) return;
    const ordered = [...entries.values()].sort((a, b) => a.seq - b.seq);
    const projectedRuns = [...runs.values()].sort((a, b) => a.firstSeq - b.firstSeq).map(run => ({
      ...run, entries: ordered.filter(entry => entry.runId === run.runId),
    }));
    // Ad-hoc run reads may arrive beyond a disconnected gap. They cannot move
    // the catch-up checkpoint past entries that have never been fetched.
    let afterSeq = Math.max(snapshot.afterSeq, patch.afterSeq ?? 0);
    const sequences = new Set(ordered.map(entry => entry.seq));
    while (sequences.has(afterSeq + 1)) afterSeq++;
    snapshot = {...snapshot, ...patch, entries: ordered, runs: projectedRuns,
      messages: ordered.flatMap(entry => { const message = entryMessage(entry); return message ? [message] : []; }),
      afterSeq};
    for (const listener of listeners) try { listener(); } catch { /* Isolate observers. */ }
  };
  const ingestEntry = (value: Entry) => {
    if (value.sessionId !== sessionId) return;
    const existing = entries.get(value.id);
    if (existing && existing.updatedAt > value.updatedAt) return;
    const next = structuredClone(value);
    // Outcome/output only appear after insertion. A stale same-millisecond read cannot erase them.
    if (existing) for (const field of ['narrative', 'output'] as const) {
      if (existing.extData[field] !== undefined && next.extData[field] === undefined) next.extData[field] = existing.extData[field];
    }
    entries.set(next.id, next);
  };
  const ingest = (value: StoredRun) => {
    for (const entry of value.entries) ingestEntry(entry);
    const {entries: _entries, ...metadata} = value;
    const existing = runs.get(value.runId);
    const merged = {...metadata, firstSeq: Math.min(existing?.firstSeq ?? metadata.firstSeq, metadata.firstSeq),
      lastSeq: Math.max(existing?.lastSeq ?? metadata.lastSeq, metadata.lastSeq)};
    runs.set(value.runId, existing && terminal(existing.status) && !terminal(value.status)
      ? {...merged, status: existing.status, finishedAt: existing.finishedAt, stopReason: existing.stopReason}
      : merged);
  };
  const call = async <T,>(path: string): Promise<T> => {
    if (disposed) throw new DOMException('History controller disposed', 'AbortError');
    const controller = new AbortController(); pending.add(controller);
    try {
      const result = await request<T>(path, {signal: controller.signal});
      if (disposed) throw new DOMException('History controller disposed', 'AbortError');
      return result;
    } finally { pending.delete(controller); }
  };
  const query = (options: RunQuery = {}): Promise<RunPage> => {
    const params = new URLSearchParams();
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    if (options.afterSeq !== undefined) params.set('afterSeq', String(options.afterSeq));
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    return call<RunPage>(base + '/narrative/runs' + (params.size ? '?' + params.toString() : ''));
  };
  const readRun = async (runId: string) => {
    const result = await call<{item: StoredRun}>(base + '/narrative/runs/' + encodeURIComponent(runId));
    ingest(result.item);
    emit({activeRunId: snapshot.activeRunId === runId && terminal(result.item.status) ? null : snapshot.activeRunId});
    return result.item;
  };
  const activeFrom = (page: RunPage) => {
    const id = page.activeRunId;
    return id && !terminal(runs.get(id)?.status ?? 'unknown') ? id : null;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    query,
    readRun,
    ingestRun(run: StoredRun) {
      if (disposed) return;
      ingest(run);
      emit({activeRunId: snapshot.activeRunId === run.runId && terminal(run.status) ? null : snapshot.activeRunId});
    },
    ingestEntries(values: readonly Entry[]) {
      if (disposed) return;
      for (const entry of values) ingestEntry(entry);
      const groups = new Map<string, Entry[]>();
      for (const entry of entries.values()) groups.set(entry.runId, [...(groups.get(entry.runId) ?? []), entry]);
      for (const [runId, group] of groups) {
        group.sort((a, b) => a.seq - b.seq);
        const current = runs.get(runId);
        const outcome = group[0]?.extData.narrative as {status?: StoredRun['status']; stopReason?: string; finishedAt?: number} | undefined;
        runs.set(runId, {runId, firstSeq: group[0]!.seq, lastSeq: group.at(-1)!.seq,
          status: outcome?.status === 'completed' || outcome?.status === 'stopped' ? outcome.status : current?.status ?? 'unknown',
          ...(outcome?.stopReason ? {stopReason: outcome.stopReason} : {}),
          ...(outcome?.finishedAt !== undefined ? {finishedAt: outcome.finishedAt} : {})});
      }
      emit();
    },
    async loadRecent() {
      const version = ++recentVersion;
      emit({loading: true, error: null});
      try {
        const page = await query();
        if (version !== recentVersion || disposed) return page;
        for (const run of page.items) ingest(run);
        const pagination = initialized ? {} : {nextCursor: page.nextCursor, hasMore: page.hasMore};
        initialized = true;
        emit({...pagination, loading: false, activeRunId: activeFrom(page), afterSeq: page.nextAfterSeq ?? snapshot.afterSeq});
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
        for (const run of page.items) ingest(run);
        emit({loadingMore: false, nextCursor: page.nextCursor, hasMore: page.hasMore});
        return page;
      } catch (error) {
        if (!disposed && version === olderVersion) emit({loadingMore: false, error: errorText(error)});
        throw error;
      }
    },
    /** All forward pages are consumed; an empty page never resets the checkpoint. */
    async catchUp() {
      let afterSeq = snapshot.afterSeq, last: RunPage | null = null;
      try {
        while (!disposed) {
          const page = await query({afterSeq}); last = page;
          for (const run of page.items) ingest(run);
          const next = page.nextAfterSeq;
          emit({activeRunId: activeFrom(page), afterSeq: next ?? afterSeq, error: null});
          if (!page.hasMore) return page;
          if (next === null || next <= afterSeq) throw new Error('历史补查游标未前进');
          afterSeq = next;
        }
        return last;
      } catch (error) {
        if (!disposed) emit({error: errorText(error)});
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
