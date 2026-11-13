import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ErrorCodes, errorInfo, type PublicError } from '../../common/error-codes.js';
import { RuntimeError } from '../shared/errors.js';
import { readAncestors } from '../../domain/session/ancestors.js';
import { fingerprint } from '../config.js';
import { publicRunResult } from '../../domain/session/run-result.js';
import type { SummaryCandidate } from '../types.js';
import { decodeMessageState, type Json } from '../../domain/state/state.js';
import { historyFingerprint, type HistoryItem } from '../context/compaction/history.js';

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
    const preparation = row ?? this.db.prepare('SELECT run_id FROM run_preparations WHERE session_id=? AND request_id=?').get(sessionId, requestId);
    return preparation ? String(preparation.run_id) : null;
  }
  tip(sessionId: string): string | null {
    const row = this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId);
    return row?.tip_entry_id == null ? null : String(row.tip_entry_id);
  }
  status(sessionId: string, runId: string): (Record<string, any> & { status: string; tipEntryId: string | null }) | null {
    const rows = this.db.prepare("SELECT id,type,role,payload,ext_data FROM entries WHERE session_id=? AND run_id=? ORDER BY seq ASC").all(sessionId, runId);
    const user = rows.find(row=>row.role==='user');
    if (!user) {
      const preparation = this.db.prepare('SELECT * FROM run_preparations WHERE session_id=? AND run_id=?').get(sessionId, runId);
      if (!preparation) return null;
      const result = publicRunResult({ ...JSON.parse(String(preparation.result_json)), runId, status: preparation.status });
      return { ...result, runId, status: String(result.status), tipEntryId: this.tip(sessionId), messages: [],
        ...(preparation.input_text !== null ? { input: { text: String(preparation.input_text) } } : {}) };
    }
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
      const get = this.db.prepare('SELECT id,parent_id,seq,type,role,payload,ext_data FROM entries WHERE session_id=? AND id=?');
      let previous = get.get(sessionId, parentId), childSeq = seq;
      if (!previous) throw new RuntimeError(ErrorCodes.INVALID_PARENT_CHAIN);
      while (previous) {
        if (Number(previous.seq) >= childSeq) throw new RuntimeError(ErrorCodes.INVALID_PARENT_CHAIN);
        if (this.narrative(previous).length) break;
        childSeq = Number(previous.seq);
        if (previous.parent_id === null) { previous = undefined; break; }
        previous = get.get(sessionId, String(previous.parent_id));
        if (!previous) throw new RuntimeError(ErrorCodes.INVALID_PARENT_CHAIN);
      }
      if (previous) this.db.prepare('UPDATE entries SET branch_count=1 WHERE id=?').run(String(previous.id));
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
  beginPreparation(args: { sessionId: string; runId: string; requestId: string; expectedTip: string; input: string }, beginJournal: () => void): void {
    this.transaction(() => {
      if (this.duplicate(args.sessionId, args.requestId)) throw new RuntimeError(ErrorCodes.REQUEST_ALREADY_EXISTS);
      if (this.tip(args.sessionId) !== args.expectedTip) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
      beginJournal();
      this.db.prepare('INSERT INTO run_preparations(run_id,session_id,request_id,expected_tip_entry_id,input_text,status,created_at,result_json) VALUES(?,?,?,?,?,?,?,?)')
        .run(args.runId, args.sessionId, args.requestId, args.expectedTip, args.input, 'preparing', Date.now(), JSON.stringify({ runId: args.runId, phase: 'preparing' }));
    });
  }
  updatePreparation(runId: string, metadata: Record<string, unknown>): void {
    this.db.prepare("UPDATE run_preparations SET result_json=json_patch(result_json,?) WHERE run_id=? AND status='preparing'")
      .run(JSON.stringify(metadata), runId);
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
      const prep = this.db.prepare("SELECT input_text,request_id,expected_tip_entry_id FROM run_preparations WHERE run_id=? AND session_id=? AND status='preparing'").get(runId, sessionId);
      if (!prep || prep.input_text !== input || prep.request_id !== requestId || prep.expected_tip_entry_id !== args.expectedTip)
        throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
      if (summary) {
        const history = this.ancestors(sessionId, args.expectedTip).flatMap(row => this.narrative(row));
        const index = history.findIndex(item => item.id === summary.coveredThroughEntryId);
        if (index < 0 || !summary.sourceFingerprint || summary.sourceFingerprint !== historyFingerprint(history) ||
            summary.firstKeptEntryId !== history[index + 1]?.id || (history[index + 1] && history[index + 1]!.role !== 'user'))
          throw new RuntimeError(ErrorCodes.INVALID_SUMMARY_BOUNDARY);
      }
      let tip = args.expectedTip;
      if (summary) tip = this.append(sessionId, tip, runId, 'compaction', null, { summary: summary.text },
        { summary: { kind: 'sillyrealms.summary', coveredThroughEntryId: summary.coveredThroughEntryId, gaps: summary.gaps ?? [], generation } });
      this.append(sessionId, tip, runId, 'message', 'user',
        { message: { role: 'user', content: input, timestamp: Date.now() } },
        { requestId, run: { runId, status: 'running', ...args.publicRun }, runtime: { ...args.runtimeSnapshot, diagnostics, finalized: false } }, userId);
      this.db.prepare('DELETE FROM run_preparations WHERE run_id=?').run(runId);
    });
  }
  completeAssistant(sessionId: string, runId: string, message: object, text: string, streamedId: string | null, streamedText: string): string {
    return this.transaction(() => {
      const append = (value: object, ext: object, id?: string) =>
        this.append(sessionId, String(this.tip(sessionId)), runId, 'message', 'assistant', { message: value }, ext, id);
      if (streamedId && text !== streamedText) {
        append({ role: 'assistant', content: [{ type: 'text', text: streamedText }] }, { origin: 'stream_partial', status: 'completed' }, streamedId);
        return append(message, { origin: 'pi', status: 'completed', nonNarrative: true });
      }
      return append(message, { origin: 'pi', status: 'completed' }, streamedId ?? undefined);
    });
  }
  appendToolResult(sessionId: string, runId: string, message: object): void {
    this.appendAtomic(sessionId, runId, 'message', 'toolResult', { message }, {});
  }
  finalize(sessionId: string, userId: string, partialId: string | null, outcome: RunOutcome,
    workspace: Record<string, Json>, runFailure: PublicError | null = null, options: {
      expectedTip?: string; baselineHash?: string; allowState?: boolean;
      publicRun?: Record<string, unknown>; diagnostics?: unknown;
      pendingMessage?: { id: string; role: 'assistant'; text: string };
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
      if (options.pendingMessage?.text) {
        const message = options.pendingMessage;
        this.append(sessionId, String(tip), String(user.run_id), 'message', 'assistant',
          { message: { role: 'assistant', content: [{ type: 'text', text: message.text }] } },
          { origin: 'stream_partial', status: outcome }, message.id);
      }
      if (partialId) {
        const row = this.db.prepare('SELECT ext_data FROM entries WHERE id=? AND run_id=?').get(partialId, String(user.run_id));
        if (row) this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?')
          .run(JSON.stringify({ ...JSON.parse(String(row.ext_data)), status: outcome }), partialId);
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
