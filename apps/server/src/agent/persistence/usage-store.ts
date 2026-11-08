import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Usage } from '@earendil-works/pi-ai';
import { readAncestors } from '../../domain/session/ancestors.js';

export type ModelPhase = 'summary' | 'generation' | 'continuation' | 'state_review';
export type RequestMeta = {
  sessionId: string; runId: string; requestId: string;
  phase: ModelPhase; apiModelConfigId?: string;
};
export type TokenTotals = {
  inputTokens: number; outputTokens: number; totalTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
};
export type RequestMetrics = RequestMeta & {
  modelId: string; contextWindowTokens: number; startedAt: number;
  status: 'started' | 'completed' | 'error' | 'aborted' | 'interrupted';
  usageStatus: 'pending' | 'reported' | 'unavailable';
  usage: TokenTotals | null;
  firstTextMs?: number;
  durationMs?: number;
  finishedAt?: number;
};
type PendingRun = {
  runId: string; requestId: string; startedAt: number;
  requests: RequestMetrics[]; firstVisibleTextMs?: number;
};
export type SessionUsage = {
  cumulative: TokenTotals & { reportedCount: number; unknownCount: number };
  latestContext: null | {
    inputTokens: number; contextWindowTokens: number; modelId: string;
    apiModelConfigId?: string; runId: string; requestId: string; finishedAt: number;
  };
  pendingRun: PendingRun | null;
  // Only when a provider used tokens before a User Entry could be created.
  // Bounded historical aggregate for preparation failures with no User Entry.
  unattachedTotals?: TokenTotals & { runCount: number; reportedCount: number; unknownCount: number };
  historicalUsageUnknown?: boolean;
};

const emptyTotals = (): TokenTotals => ({
  inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
});
export const emptyUsage = (): SessionUsage => ({
  cumulative: { ...emptyTotals(), reportedCount: 0, unknownCount: 0 },
  latestContext: null,
  pendingRun: null,
});
const parseUsage = (value: unknown): SessionUsage => {
  if (typeof value !== 'string') return emptyUsage();
  const parsed = JSON.parse(value) as SessionUsage;
  if (!parsed.cumulative || !('pendingRun' in parsed)) throw new Error('INVALID_SESSION_USAGE');
  return parsed;
};
const asTokens = (value: Usage | undefined): TokenTotals | null => {
  if (!value) return null;
  const fields = [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens];
  if (!fields.every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  return {
    inputTokens: value.input + value.cacheRead + value.cacheWrite,
    outputTokens: value.output,
    totalTokens: value.totalTokens,
    cacheReadTokens: value.cacheRead,
    cacheWriteTokens: value.cacheWrite,
  };
};
const mergeTotals = (target: TokenTotals, add: TokenTotals): void => {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    target[key] += add[key];
  }
};

/** An Entry is the durable message detail. The Session holds the active Run journal and settled totals. */
export class UsageStore {
  constructor(private db: DatabaseSync) {}

  private load(sessionId: string): SessionUsage {
    const row = this.db.prepare('SELECT usage_json FROM sessions WHERE id=?').get(sessionId);
    if (!row) throw new Error('SESSION_NOT_FOUND');
    return parseUsage(row.usage_json);
  }
  private save(sessionId: string, usage: SessionUsage): void {
    this.db.prepare('UPDATE sessions SET usage_json=? WHERE id=?').run(JSON.stringify(usage), sessionId);
  }

  beginRun(sessionId: string, runId: string, requestId: string): void {
    let usage = this.load(sessionId);
    if (usage.pendingRun) {
      if (usage.pendingRun.runId === runId) return;
      // This runtime has already released the old Run; recover its durable
      // request journal before starting a new one instead of blocking forever.
      const oldRunId = usage.pendingRun.runId;
      const userRow = this.db.prepare("SELECT ext_data FROM entries WHERE session_id=? AND run_id=? AND role='user'")
        .get(sessionId, oldRunId);
      const savedStatus = userRow ? (JSON.parse(String(userRow.ext_data)).run?.status as string | undefined) : undefined;
      const terminal = savedStatus && ['completed', 'failed', 'stopped', 'interrupted'].includes(savedStatus)
        ? savedStatus : 'interrupted';
      this.settleRun(sessionId, oldRunId, terminal);
      usage = this.load(sessionId);
    }
    usage.pendingRun = { runId, requestId, startedAt: Date.now(), requests: [] };
    this.save(sessionId, usage);
  }

  /** Called before accessing the provider: a crash must not erase a started request. */
  beginRequest(meta: RequestMeta, modelId: string, contextWindowTokens: number): void {
    const usage = this.load(meta.sessionId), pending = usage.pendingRun;
    if (!pending || pending.runId !== meta.runId) throw new Error('RUN_USAGE_NOT_ACTIVE');
    if (pending.requests.some(r => r.requestId === meta.requestId)) return;
    pending.requests.push({
      ...meta, modelId, contextWindowTokens, startedAt: Date.now(),
      status: 'started', usageStatus: 'pending', usage: null,
    });
    this.save(meta.sessionId, usage);
  }

  /** Single final transition; late provider results or duplicate callbacks cannot count twice. */
  finishRequest(meta: RequestMeta, status: RequestMetrics['status'], providerUsage: Usage | undefined,
    firstTextMs: number | undefined, durationMs: number): void {
    const usage = this.load(meta.sessionId), pending = usage.pendingRun;
    if (!pending || pending.runId !== meta.runId) return;
    const record = pending.requests.find(r => r.requestId === meta.requestId);
    if (!record || record.usageStatus !== 'pending') return;
    const totals = asTokens(providerUsage);
    record.status = status;
    record.usageStatus = totals ? 'reported' : 'unavailable';
    record.usage = totals;
    record.firstTextMs = firstTextMs;
    record.durationMs = durationMs;
    record.finishedAt = Date.now();
    this.save(meta.sessionId, usage);
  }

  /** Associate a model response with its one durable Assistant Entry. */
  attachEntry(sessionId: string, runId: string, requestId: string, entryId: string): void {
    const usage = this.load(sessionId);
    const record = usage.pendingRun?.runId === runId
      ? usage.pendingRun.requests.find(r => r.requestId === requestId) : undefined;
    if (!record) return;
    this.db.prepare('UPDATE entries SET metrics_json=? WHERE id=? AND session_id=? AND run_id=?')
      .run(JSON.stringify(record), entryId, sessionId, runId);
  }

  attachCompaction(sessionId: string, runId: string): void {
    const usage = this.load(sessionId);
    if (usage.pendingRun?.runId !== runId) return;
    const records = usage.pendingRun.requests.filter(r => r.phase === 'summary');
    const row = this.db.prepare("SELECT id FROM entries WHERE session_id=? AND run_id=? AND type='compaction'").get(sessionId, runId);
    if (row && records.length) this.db.prepare('UPDATE entries SET metrics_json=? WHERE id=?')
      .run(JSON.stringify({ requests: records }), String(row.id));
  }

  firstVisible(sessionId: string, runId: string, elapsed: number): void {
    const usage = this.load(sessionId);
    if (usage.pendingRun?.runId !== runId || usage.pendingRun.firstVisibleTextMs !== undefined) return;
    usage.pendingRun.firstVisibleTextMs = elapsed;
    this.save(sessionId, usage);
  }

  /**
   * Seal exactly once. Entries provide per-message detail, pendingRun retains
   * requests with no Entry (including failed preparation or provider errors).
   */
  settleRun(sessionId: string, runId: string, status: string, durationMs?: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.load(sessionId), pending = session.pendingRun;
      if (!pending || pending.runId !== runId) { this.db.exec('COMMIT'); return false; }
      const entries = this.db.prepare('SELECT id,type,role,metrics_json FROM entries WHERE session_id=? AND run_id=? ORDER BY seq')
        .all(sessionId, runId);
      const requests = new Map<string, RequestMetrics>();
      for (const row of entries) {
        if (!row.metrics_json || row.role === 'user') continue;
        const m = JSON.parse(String(row.metrics_json)) as RequestMetrics & { requests?: RequestMetrics[] };
        for (const item of (Array.isArray(m.requests) ? m.requests : [m])) {
          if (item.requestId) requests.set(item.requestId, item);
        }
      }
      for (const item of pending.requests) {
        // The journal is authoritative for terminal status; Entry copies may have been created earlier.
        requests.set(item.requestId, item.usageStatus === 'pending'
          ? { ...item, status: 'interrupted', usageStatus: 'unavailable' } : item);
      }
      const totals = emptyTotals();
      let reportedCount = 0, unknownCount = 0;
      let latest: SessionUsage['latestContext'] = null;
      for (const item of requests.values()) {
        if (item.usageStatus === 'reported' && item.usage) {
          mergeTotals(totals, item.usage);
          reportedCount++;
          if ((item.phase === 'generation' || item.phase === 'continuation') && item.finishedAt &&
            (!latest || item.finishedAt >= latest.finishedAt)) {
            latest = {
              inputTokens: item.usage.inputTokens, contextWindowTokens: item.contextWindowTokens,
              modelId: item.modelId, apiModelConfigId: item.apiModelConfigId,
              runId, requestId: item.requestId, finishedAt: item.finishedAt,
            };
          }
        } else unknownCount++;
      }
      const user = entries.find(row => row.role === 'user');
      if (user) {
        this.db.prepare('UPDATE entries SET metrics_json=? WHERE id=?').run(JSON.stringify({
          run: {
            runId, status, accounted: true, ...totals, reportedCount, unknownRequestCount: unknownCount,
            timing: { firstVisibleTextMs: pending.firstVisibleTextMs ?? null, totalDurationMs: durationMs ?? null },
          },
        }), String(user.id));
      } else if (reportedCount || unknownCount) {
        // Keep one bounded aggregate rather than an unbounded list of failed
        // preparation requests with no User Entry.
        const unmatched = session.unattachedTotals ?? {
          ...emptyTotals(), runCount: 0, reportedCount: 0, unknownCount: 0,
        };
        mergeTotals(unmatched, totals);
        unmatched.runCount++;
        unmatched.reportedCount += reportedCount;
        unmatched.unknownCount += unknownCount;
        session.unattachedTotals = unmatched;
      }
      mergeTotals(session.cumulative, totals);
      session.cumulative.reportedCount += reportedCount;
      session.cumulative.unknownCount += unknownCount;
      if (latest && (!session.latestContext || latest.finishedAt >= session.latestContext.finishedAt)) session.latestContext = latest;
      session.pendingRun = null;
      this.save(sessionId, session);
      this.db.exec('COMMIT');
      return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Works only for the two persisted dimensions; doesn't alter the active Run. */
  view(sessionId: string): {
    cumulative: SessionUsage['cumulative'] & { cacheHitRate: number | null; complete: boolean };
    latestContext: (NonNullable<SessionUsage['latestContext']> & { ratio: number | null; stale: boolean }) | null;
  } {
    const usage = this.load(sessionId);
    const { cumulative } = usage;
    const cacheHitRate = cumulative.inputTokens > 0 && cumulative.unknownCount === 0 && !usage.historicalUsageUnknown
      ? cumulative.cacheReadTokens / cumulative.inputTokens : null;
    let latestContext: ReturnType<UsageStore['view']>['latestContext'] = null;
    if (usage.latestContext) {
      const snapshot = usage.latestContext;
      const session = this.db.prepare('SELECT tip_entry_id,api_model_config_id FROM sessions WHERE id=?').get(sessionId);
      let branchStale = true;
      if (session?.tip_entry_id) {
        try {
          branchStale = !readAncestors(this.db, sessionId, String(session.tip_entry_id))
            .some(row => row.run_id === snapshot.runId);
        } catch { branchStale = true; }
      }
      latestContext = {
        ...snapshot,
        ratio: snapshot.contextWindowTokens > 0 ? snapshot.inputTokens / snapshot.contextWindowTokens : null,
        stale: branchStale || (snapshot.apiModelConfigId !== undefined && snapshot.apiModelConfigId !== session?.api_model_config_id),
      };
    }
    return {
      cumulative: {
        ...cumulative, cacheHitRate,
        complete: cumulative.unknownCount === 0 && !usage.historicalUsageUnknown,
        ...(usage.historicalUsageUnknown ? { historicalUsageUnknown: true } : {}),
      },
      latestContext,
    };
  }
}

/** Non-durable timings stay in the Run context; the Session journal stores persisted request data. */
export class RunContext {
  private started = performance.now();
  private nextRequestIndex = 0;
  private firstTextSeen = false;

  constructor(readonly sessionId: string, readonly runId: string, readonly apiModelConfigId?: string) {}

  request(phase: ModelPhase): RequestMeta {
    this.nextRequestIndex++;
    return { sessionId: this.sessionId, runId: this.runId, requestId: randomUUID(),
      phase, apiModelConfigId: this.apiModelConfigId };
  }
  firstVisible(usage: UsageStore): void {
    if (this.firstTextSeen) return;
    this.firstTextSeen = true;
    usage.firstVisible(this.sessionId, this.runId, Math.max(0, Math.round(performance.now() - this.started)));
  }
  durationMs(): number { return Math.max(0, Math.round(performance.now() - this.started)); }
}
