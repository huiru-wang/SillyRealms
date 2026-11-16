import type { DatabaseSync } from 'node:sqlite';
import { storedRunResult } from '../../domain/session/run-result.js';

/** Offline cleanup only. Runtime readers support the target shape without legacy fallbacks. */
export function compactRunMetadata(db: DatabaseSync) {
  if (Number(db.prepare('PRAGMA user_version').get()!.user_version) !== 6) throw Error('Expected schema v6');
  let entries = 0, preparations = 0, bytesRemoved = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const update = db.prepare('UPDATE entries SET ext_data=? WHERE id=?');
    for (const row of db.prepare('SELECT id,type,role,ext_data,updated_at FROM entries').all()) {
      const before = String(row.ext_data), old = JSON.parse(before), next: Record<string, unknown> = {};
      if (row.type === 'compaction') {
        if (typeof old.summary?.coveredThroughEntryId !== 'string') throw Error('Invalid summary boundary');
        next.summary = { coveredThroughEntryId: old.summary.coveredThroughEntryId };
      } else if (row.role === 'user') {
        if (typeof old.requestId !== 'string' || !['running','completed','failed','stopped','interrupted'].includes(old.run?.status)) throw Error('Invalid run metadata');
        next.requestId = old.requestId;
        next.run = storedRunResult(old.run);
      } else if (old.origin === 'opening') next.origin = 'opening';
      const after = JSON.stringify(next);
      if (after !== before) {
        update.run(after, String(row.id));
        // Metadata maintenance must not change the user's message edit time.
        db.prepare('UPDATE entries SET updated_at=? WHERE id=?').run(row.updated_at!, String(row.id));
        entries++; bytesRemoved += Buffer.byteLength(before) - Buffer.byteLength(after);
      }
    }
    for (const row of db.prepare('SELECT run_id,result_json FROM run_preparations').all()) {
      const before = String(row.result_json), { status: _status, ...result } = storedRunResult(JSON.parse(before));
      const after = JSON.stringify(result);
      if (after !== before) {
        db.prepare('UPDATE run_preparations SET result_json=? WHERE run_id=?').run(after, String(row.run_id));
        preparations++; bytesRemoved += Buffer.byteLength(before) - Buffer.byteLength(after);
      }
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Reference validation failed');
    db.exec('COMMIT');
    return { entries, preparations, bytesRemoved };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
