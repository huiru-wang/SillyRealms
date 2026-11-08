import { ErrorCodes } from '../../common/error-codes.js';
import type { DatabaseSync } from 'node:sqlite';

type Entry = Record<string, any>;
/** Read exactly one valid parent chain, never entries from a different session. */
export function readAncestors(db:DatabaseSync, sessionId:string, tip:string):Entry[] {
  const rows=db.prepare(`WITH RECURSIVE ancestors AS (
    SELECT * FROM entries WHERE session_id=? AND id=?
    UNION SELECT e.* FROM entries e JOIN ancestors a ON a.parent_id=e.id WHERE e.session_id=?
  ) SELECT * FROM ancestors ORDER BY seq`).all(sessionId,tip,sessionId) as Entry[];
  if (!rows.length || rows[rows.length-1]!.id !== tip || rows[0]!.parent_id !== null || rows.some((row,index)=>index>0 && row.parent_id !== rows[index-1]!.id)) throw new Error(ErrorCodes.INVALID_PARENT_CHAIN);
  return rows;
}
