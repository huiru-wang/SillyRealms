import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ErrorCodes, errorInfo, type PublicError } from '../../common/error-codes.js';
import { RuntimeError } from '../shared/errors.js';
import { readAncestors } from '../../domain/session/ancestors.js';
import { fingerprint } from '../config.js';
import { publicRunResult } from '../../domain/session/run-result.js';
import type { SummaryCandidate } from '../types.js';
import { decodeMessageState, type Json } from '../../domain/state/state.js';
import type { HistoryItem } from '../context/history-compactor.js';

export type RunRow = Record<string, any>;
export type RunOutcome = 'completed' | 'stopped' | 'failed';

/** Business-level persistence operations; callers never handle SQL transactions. */
export class RunStore {
  constructor(private db: DatabaseSync) {}

  worldId(sessionId: string): string | null {
    const row = this.db.prepare('SELECT world_id FROM sessions WHERE id=?').get(sessionId);
    return row ? String(row.world_id) : null;
  }
  session(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as RunRow | undefined;
  }
  preset(id: string): RunRow | undefined {
    return this.db.prepare('SELECT config_json FROM presets WHERE id=?').get(id) as RunRow | undefined;
  }
  modelConfig(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM api_model_configs WHERE id=?').get(id) as RunRow | undefined;
  }
  world(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM worlds WHERE id=?').get(id) as RunRow | undefined;
  }
  duplicate(sessionId: string, requestId: string): string | null {
    const row = this.db.prepare("SELECT run_id FROM entries WHERE session_id=? AND role='user' AND json_extract(ext_data,'$.requestId')=?").get(sessionId, requestId);
    return row ? String(row.run_id) : null;
  }
  tip(sessionId: string): string | null {
    const row = this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId);
    return row?.tip_entry_id == null ? null : String(row.tip_entry_id);
  }
  status(sessionId: string, runId: string): (Record<string, any> & { status: string; tipEntryId: string | null }) | null {
    const rows = this.db.prepare("SELECT id,type,role,payload,ext_data FROM entries WHERE session_id=? AND run_id=? ORDER BY seq ASC").all(sessionId, runId);
    const user = rows.find(row=>row.role==='user');
    if (!user) return null;
    const result=publicRunResult(JSON.parse(String(user.ext_data)).run);
    return { ...result, runId, status: String(result.status), tipEntryId: this.tip(sessionId),
      messages: rows.flatMap(row=>this.narrative(row)) };
  }
  ancestors(sessionId: string, tip: string): RunRow[] {
    try { return readAncestors(this.db, sessionId, tip); }
    catch { throw new RuntimeError(ErrorCodes.INVALID_PARENT_CHAIN); }
  }
  narrative(row: RunRow): HistoryItem[] {
    if (row.type !== 'message' || !['user', 'assistant'].includes(row.role)) return [];
    const ext = JSON.parse(String(row.ext_data));
    if (ext.nonNarrative) return [];
    const message = JSON.parse(String(row.payload)).message;
    if (!message || message.role !== row.role) throw new RuntimeError(ErrorCodes.ENTRY_ROLE_MISMATCH);
    const text = typeof message.content === 'string' ? message.content :
      Array.isArray(message.content) ? message.content.filter((p: { type: string }) => p.type === 'text').map((p: { text: string }) => p.text).join('') : '';
    return text ? [{ id: row.id, role: row.role, text }] : [];
  }
  private append(sessionId: string, parentId: string, runId: string, type: string, role: string | null, payload: object, ext: object, id: string = randomUUID()): string {
    if (this.tip(sessionId) !== parentId) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
    const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM entries WHERE session_id=?').get(sessionId)?.seq);
    const visible = type === 'message' && (role === 'user' || role === 'assistant') &&
      this.narrative({ id, type, role, payload: JSON.stringify(payload), ext_data: JSON.stringify(ext) }).length > 0;
    if (visible) {
      const previous = [...this.ancestors(sessionId, parentId)].reverse().find(row => this.narrative(row).length > 0);
      if (previous) this.db.prepare('UPDATE entries SET branch_count=1 WHERE id=?').run(previous.id);
    }
    this.db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)')
      .run(id, sessionId, parentId, runId, seq, type, role, 0, Date.now(), JSON.stringify(payload), JSON.stringify(ext));
    this.db.prepare('UPDATE sessions SET tip_entry_id=?,updated_at=? WHERE id=?').run(id, Date.now(), sessionId);
    return id;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private appendAtomic(sessionId: string, runId: string, type: string, role: string | null, payload: object, ext: object): string {
    return this.transaction(() => this.append(sessionId, String(this.tip(sessionId)), runId, type, role, payload, ext));
  }
  startRun(args: {
    sessionId: string; expectedTip: string; runId: string; userId: string; input: string; requestId: string;
    summary?: SummaryCandidate;
    generation: Array<{ request: unknown; response: string }>;
    diagnostics: unknown; publicRun?: Record<string, unknown>; runtimeSnapshot?: Record<string, unknown>;
  }): void {
    const { sessionId, runId, input, requestId, userId, summary, generation, diagnostics } = args;
    this.transaction(() => {
      if (this.tip(sessionId) !== args.expectedTip) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
      let tip = args.expectedTip;
      if (summary) tip = this.append(sessionId, tip, runId, 'compaction', null, { summary: summary.text },
        { summary: { kind: 'sillyrealms.summary', coveredThroughEntryId: summary.coveredThroughEntryId, gaps: summary.gaps ?? [], generation } });
      this.append(sessionId, tip, runId, 'message', 'user',
        { message: { role: 'user', content: input, timestamp: Date.now() } },
        { requestId, run: { runId, status: 'running', ...args.publicRun }, runtime: { ...args.runtimeSnapshot, diagnostics, finalized: false } }, userId);
    });
  }
  createPartial(sessionId: string, runId: string, text: string): string {
    return this.appendAtomic(sessionId, runId, 'message', 'assistant',
      { message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.now() } },
      { origin: 'stream_partial', status: 'streaming' });
  }
  updatePartial(id: string, text: string): void {
    const row = this.db.prepare('SELECT payload FROM entries WHERE id=?').get(id)!;
    const payload = JSON.parse(String(row.payload));
    payload.message.content[0].text = text;
    this.db.prepare('UPDATE entries SET payload=? WHERE id=?').run(JSON.stringify(payload), id);
  }
  completeAssistant(sessionId: string, runId: string, message: object, text: string, partialId: string | null, partialText: string): string {
    const rawExt = { origin: 'pi', status: 'completed' };
    if (partialId && text === partialText) {
      this.db.prepare('UPDATE entries SET payload=?,ext_data=? WHERE id=?').run(JSON.stringify({ message }), JSON.stringify(rawExt), partialId);
      return partialId;
    }
    const id = this.appendAtomic(sessionId, runId, 'message', 'assistant', { message },
      partialId ? { ...rawExt, nonNarrative: true } : rawExt);
    return id;
  }
  appendToolResult(sessionId: string, runId: string, message: object): void {
    this.appendAtomic(sessionId, runId, 'message', 'toolResult', { message }, {});
  }
  finalize(sessionId: string, userId: string, partialId: string | null, outcome: RunOutcome,
    workspace: Record<string, Json>, runFailure: PublicError | null = null, options: {
      expectedTip?: string; baselineHash?: string; allowState?: boolean;
      publicRun?: Record<string, unknown>; diagnostics?: unknown; summary?: SummaryCandidate;
    } = {}): boolean {
    return this.transaction(() => {
      const user = this.db.prepare('SELECT * FROM entries WHERE id=? AND session_id=? AND role=?').get(userId, sessionId, 'user');
      if (!user) throw new RuntimeError(ErrorCodes.RUN_NOT_FOUND);
      const ext = JSON.parse(String(user.ext_data));
      if (ext.runtime?.finalized || ext.run.status !== 'running') return false;
      const tip = this.tip(sessionId);
      if (options.expectedTip && tip !== options.expectedTip) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
      const tipRow = this.db.prepare('SELECT run_id FROM entries WHERE id=? AND session_id=?').get(tip, sessionId);
      if (!tipRow || tipRow.run_id !== user.run_id) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
      const chain = this.ancestors(sessionId, String(tip));
      if (!chain.some(row => row.id === userId)) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
      const stateRow = [...chain].reverse().find(row => row.state !== null);
      if (options.baselineHash && fingerprint(decodeMessageState(stateRow?.state ?? '[]')) !== options.baselineHash)
        throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
      if (partialId) {
        const row = this.db.prepare('SELECT ext_data FROM entries WHERE id=? AND run_id=?').get(partialId, String(user.run_id));
        if (row) this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?')
          .run(JSON.stringify({ ...JSON.parse(String(row.ext_data)), status: outcome }), partialId);
      }
      // A continuation summary covers only completed runs preceding this run, never current tool traffic.
      if (options.summary && outcome !== 'stopped') {
        const covered = chain.find(row => row.id === options.summary!.coveredThroughEntryId);
        if (!covered || Number(covered.seq) >= Number(user.seq) || !this.narrative(covered).length)
          throw new RuntimeError(ErrorCodes.INVALID_SUMMARY_BOUNDARY);
        this.append(sessionId, String(tip), String(user.run_id), 'compaction', null, { summary: options.summary.text },
          { summary: { kind: 'sillyrealms.summary', coveredThroughEntryId: covered.id, gaps: options.summary.gaps ?? [] } });
      }
      ext.run = { ...ext.run, ...options.publicRun, status: outcome, phase: 'finalized' };
      if (outcome === 'failed') Object.assign(ext.run, runFailure ?? errorInfo(ErrorCodes.INTERNAL_ERROR));
      ext.runtime = { ...ext.runtime, finalized: true, diagnostics: options.diagnostics };
      this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(JSON.stringify(ext), userId);
      if (options.allowState ?? outcome !== 'failed') {
        this.db.prepare('UPDATE entries SET state=? WHERE id=?').run(
          JSON.stringify(Object.entries(workspace).map(([key, value]) => ({ key, value }))), String(this.tip(sessionId)));
      }
      return true;
    });
  }
  markCommitFailed(userId: string, runFailure: PublicError = errorInfo(ErrorCodes.STATE_COMMIT_FAILED), publicRun?: Record<string, unknown>): boolean {
    try {
      const user = this.db.prepare('SELECT ext_data FROM entries WHERE id=?').get(userId);
      if (user) {
        const ext = JSON.parse(String(user.ext_data));
        if (ext.runtime?.finalized || ext.run.status !== 'running') return false;
        ext.run = { ...ext.run, ...publicRun, status: 'failed', phase: 'finalized' };
        ext.runtime = { ...ext.runtime, finalized: true };
        Object.assign(ext.run, runFailure);
        this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(JSON.stringify(ext), userId);
        return true;
      }
    } catch { /* database unavailable: recovered as interrupted on restart */ }
    return false;
  }
}
