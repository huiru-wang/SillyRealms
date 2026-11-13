import type { DatabaseSync } from 'node:sqlite';
import { ErrorCodes } from '../../common/error-codes.js';

type Entry = Record<string, any>;

/** Page backward on the current parent chain, keeping each Run together. */
export function readRunPage(db: DatabaseSync, sessionId: string, tip: string, limit: number, cursor?: string) {
  let start = tip;
  if (cursor) {
    let before: number;
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (decoded.sessionId !== sessionId || !Number.isSafeInteger(decoded.before) || decoded.before < 1) throw new Error();
      before = decoded.before;
    } catch { throw new Error(ErrorCodes.INVALID_CURSOR); }
    // Validate membership using headers only; never load preceding page payloads.
    const anchor = db.prepare(`WITH RECURSIVE chain AS (
      SELECT id,parent_id,run_id,seq FROM entries WHERE session_id=? AND id=?
      UNION ALL SELECT e.id,e.parent_id,e.run_id,e.seq FROM entries e JOIN chain c ON e.id=c.parent_id
        WHERE e.session_id=? AND e.seq<c.seq AND c.seq>?
    ) SELECT * FROM chain WHERE seq=?`).get(sessionId, tip, sessionId, before, before);
    if (!anchor) throw new Error(ErrorCodes.INVALID_CURSOR);
    const parent = db.prepare('SELECT run_id FROM entries WHERE session_id=? AND id=?').get(sessionId, String(anchor.parent_id));
    if (parent?.run_id === anchor.run_id) throw new Error(ErrorCodes.INVALID_CURSOR);
    if (anchor.parent_id === null) return { groups: [], hasMore: false, nextCursor: null };
    start = String(anchor.parent_id);
  }
  const rows = db.prepare(`WITH RECURSIVE page AS (
    SELECT id,parent_id,run_id,seq,1 AS run_index FROM entries WHERE session_id=? AND id=?
    UNION ALL SELECT e.id,e.parent_id,e.run_id,e.seq,p.run_index+(e.run_id<>p.run_id)
      FROM entries e JOIN page p ON e.id=p.parent_id
      WHERE e.session_id=? AND e.seq<p.seq AND p.run_index<=?
  ) SELECT p.*,e.type,e.role,e.payload,e.ext_data,e.branch_count FROM page p
    JOIN entries e ON e.id=p.id ORDER BY p.seq DESC`).all(sessionId, start, sessionId, limit) as Entry[];
  if (!rows.length || rows.some((row, i) => i > 0 && rows[i - 1]!.parent_id !== row.id))
    throw new Error(ErrorCodes.INVALID_PARENT_CHAIN);
  const last = rows[rows.length - 1]!;
  const hasMore = Number(last.run_index) > limit;
  if (!hasMore && last.parent_id !== null) throw new Error(ErrorCodes.INVALID_PARENT_CHAIN);
  const groups: Array<{ id: string; start: number; rows: Entry[] }> = [];
  for (const row of rows.filter(row => Number(row.run_index) <= limit).reverse()) {
    let group = groups[groups.length - 1];
    if (!group || group.id !== row.run_id) {
      group = { id: String(row.run_id), start: Number(row.seq), rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return { groups, hasMore, nextCursor: hasMore
    ? Buffer.from(JSON.stringify({ sessionId, before: groups[0]!.start })).toString('base64url') : null };
}
