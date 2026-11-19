import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './connection.js';
import { bindTransaction } from './transaction.js';

describe('synchronous application transactions', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = openDatabase(':memory:'); });
  afterEach(() => db.close());

  it('rejects an async callback before executing its body', () => {
    const run = bindTransaction(db);
    let called = false;
    expect(() => {
      // @ts-expect-error Async callbacks cannot be passed to the transaction capability.
      run(async () => { called = true; });
    }).toThrow('must be synchronous');
    expect(called).toBe(false);
  });

  it('rolls back synchronous writes when an untyped caller returns a thenable', () => {
    const run = bindTransaction(db);
    expect(() => {
      // @ts-expect-error Promise-like results are forbidden even from a non-async function.
      run(() => {
        db.prepare('INSERT INTO app_settings VALUES(1,NULL,NULL,1,1)').run();
        return Promise.resolve();
      });
    }).toThrow('must not return a Promise');
    expect(db.prepare('SELECT * FROM app_settings').all()).toEqual([]);
    expect(run(() => 42)).toBe(42);
  });
});
