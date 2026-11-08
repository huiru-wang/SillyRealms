import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ErrorCodes } from '../../common/error-codes.js';
import { RuntimeError } from '../shared/errors.js';
import { readAncestors } from '../../domain/session/ancestors.js';
import type { Json } from '../../domain/state/state.js';
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
  status(sessionId: string, runId: string) {
    const rows = this.db.prepare("SELECT ext_data FROM entries WHERE session_id=? AND run_id=? AND role='user' ORDER BY seq ASC").all(sessionId, runId);
    return rows.length ? { ...JSON.parse(String(rows[0]!.ext_data)).run, tipEntryId: this.tip(sessionId) } : null;
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
    summary?: { text: string; coveredThroughEntryId: string };
    generation: Array<{ request: unknown; response: string }>;
    diagnostics: unknown;
  }): void {
    const { sessionId, runId, input, requestId, userId, summary, generation, diagnostics } = args;
    this.transaction(() => {
      if (this.tip(sessionId) !== args.expectedTip) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
      let tip = args.expectedTip;
      if (summary) tip = this.append(sessionId, tip, runId, 'compaction', null, { summary: summary.text },
        { summary: { kind: 'sillyrealms.summary', coveredThroughEntryId: summary.coveredThroughEntryId, generation } });
      this.append(sessionId, tip, runId, 'message', 'user',
        { message: { role: 'user', content: input, timestamp: Date.now() } },
        { requestId, run: { runId, status: 'running', diagnostics } }, userId);
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
  finalize(sessionId: string, userId: string, partialId: string | null, outcome: RunOutcome, workspace: Record<string, Json>): void {
    this.transaction(() => {
      if (partialId && outcome !== 'completed') {
        const row = this.db.prepare('SELECT ext_data FROM entries WHERE id=?').get(partialId);
        if (row) this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?')
          .run(JSON.stringify({ ...JSON.parse(String(row.ext_data)), status: outcome }), partialId);
      }
      const user = this.db.prepare('SELECT ext_data FROM entries WHERE id=?').get(userId);
      if (!user) throw new Error(ErrorCodes.RUN_NOT_FOUND);
      const ext = JSON.parse(String(user.ext_data));
      ext.run.status = outcome;
      this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(JSON.stringify(ext), userId);
      if (outcome !== 'failed') {
        this.db.prepare('UPDATE entries SET state=? WHERE id=?').run(
          JSON.stringify(Object.entries(workspace).map(([key, value]) => ({ key, value }))), String(this.tip(sessionId)));
      }
    });
  }
  markCommitFailed(userId: string): void {
    try {
      const user = this.db.prepare('SELECT ext_data FROM entries WHERE id=?').get(userId);
      if (user) {
        const ext = JSON.parse(String(user.ext_data));
        ext.run.status = 'failed';
        ext.run.error = 'STATE_COMMIT_FAILED';
        this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(JSON.stringify(ext), userId);
      }
    } catch { /* database unavailable: recovered as interrupted on restart */ }
  }
}
