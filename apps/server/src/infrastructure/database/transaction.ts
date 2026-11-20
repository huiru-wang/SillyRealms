import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';

type SyncResult<T> = T extends PromiseLike<unknown> ? never : T;
export type TransactionRunner = <T>(work: () => T & SyncResult<T>) => T;

let savepointSequence = 0;

/** Only synchronous DB work; nested Repository operations remain inside the caller's transaction. */
function executeTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (types.isAsyncFunction(work)) throw new TypeError('Transaction callback must be synchronous');
  const name = 'sr_v2_' + ++savepointSequence;
  db.exec('SAVEPOINT ' + name);
  try {
    const value = work();
    if (value !== null && (typeof value === 'object' || typeof value === 'function')
      && 'then' in value && typeof value.then === 'function') {
      throw new TypeError('Transaction callback must not return a Promise');
    }
    db.exec('RELEASE SAVEPOINT ' + name);
    return value;
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT ' + name);
    db.exec('RELEASE SAVEPOINT ' + name);
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, work: () => T & SyncResult<T>): T {
  return executeTransaction<T>(db, work);
}

/** Startup binds this narrow capability to the same connection borrowed by all Repositories. */
export function bindTransaction(db: DatabaseSync): TransactionRunner {
  return <T>(work: () => T): T => executeTransaction<T>(db, work);
}
