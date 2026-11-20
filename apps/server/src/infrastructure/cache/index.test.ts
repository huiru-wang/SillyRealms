import { describe, expect, it } from 'vitest';
import { ERRORS } from '../../errors.js';
import { RuntimeCache } from './index.js';

const owner = { sessionId: 'one', worldId: 'world', runId: 'run-one' };

describe('in-memory run write ownership', () => {
  it('blocks external writes and rejects forged, foreign and expired permits', () => {
    const cache = new RuntimeCache();
    const permit = cache.acquireRun(owner);
    expect(Object.isFrozen(permit)).toBe(true);
    expect(() => cache.acquireRun(owner)).toThrow('RUN_ALREADY_ACTIVE');
    expect(() => cache.assertSessionWrite('one')).toThrow('SESSION_WRITE_LOCKED');
    expect(() => cache.assertStateWrite('one')).toThrow('STATE_WRITE_LOCKED');
    expect(() => cache.assertSessionWrite('one', { ...permit })).toThrow('SESSION_WRITE_LOCKED');
    expect(() => cache.assertSessionWrite('other', permit)).toThrow('SESSION_WRITE_LOCKED');
    expect(() => cache.assertSessionWrite('one', permit)).not.toThrow();
    expect(() => cache.assertStateWrite('one', permit)).not.toThrow();
    cache.releaseRun({ ...permit });
    expect(() => cache.assertSessionWrite('one')).toThrow('SESSION_WRITE_LOCKED');
    cache.releaseRun(permit);
    expect(() => cache.assertSessionWrite('one')).not.toThrow();
    expect(() => cache.assertStateWrite('one')).not.toThrow();
    expect(() => cache.assertSessionWrite('one', permit)).toThrow('SESSION_WRITE_LOCKED');
  });

  it('keeps a newer run locked when an earlier finalizer releases again', () => {
    const cache = new RuntimeCache();
    const first = cache.acquireRun(owner);
    cache.releaseRun(first);
    const second = cache.acquireRun({ ...owner, runId: 'run-two' });
    cache.releaseRun(first);
    expect(() => cache.assertSessionWrite('one')).toThrow('SESSION_WRITE_LOCKED');
    expect(() => cache.assertSessionWrite('one', first)).toThrow('SESSION_WRITE_LOCKED');
    expect(() => cache.assertSessionWrite('one', second)).not.toThrow();
    cache.releaseRun(second);
    cache.releaseRun(second);
    expect(() => cache.assertSessionWrite('one')).not.toThrow();
  });

  it('locks shared global state until every run in that world settles', () => {
    const cache = new RuntimeCache();
    const one = cache.acquireRun(owner);
    const two = cache.acquireRun({ ...owner, sessionId: 'two', runId: 'run-two' });
    expect(() => cache.assertSessionWrite('three')).not.toThrow();
    expect(() => cache.assertStateWrite('three')).not.toThrow();
    expect(() => cache.assertGlobalStateWrite('other-world')).not.toThrow();
    cache.releaseRun(one);
    expect(() => cache.assertGlobalStateWrite('world')).toThrow('STATE_WRITE_LOCKED');
    cache.releaseRun(two);
    expect(() => cache.assertGlobalStateWrite('world')).not.toThrow();
  });

  it('maps both write conflicts to explicit HTTP 409 codes', () => {
    expect(ERRORS.SESSION_WRITE_LOCKED.status).toBe(409);
    expect(ERRORS.STATE_WRITE_LOCKED.status).toBe(409);
  });
});
