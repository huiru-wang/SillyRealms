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

describe('world update admission', () => {
  it('excludes runs and assists in either direction and preserves permit identity', () => {
    const cache = new RuntimeCache();
    const run = cache.acquireRun(owner);
    expect(() => cache.acquireWorldUpdate('world')).toThrow('WORLD_UPDATE_BUSY');
    cache.releaseRun(run);
    const assist = cache.acquireReplyAssist('one', 'assist', 'world');
    expect(() => cache.acquireWorldUpdate('world')).toThrow('WORLD_UPDATE_BUSY');
    cache.releaseReplyAssist(assist);
    const permit = cache.acquireWorldUpdate('world');
    expect(() => cache.acquireWorldUpdate('world')).toThrow('WORLD_UPDATE_BUSY');
    expect(() => cache.acquireRun(owner)).toThrow('WORLD_UPDATE_IN_PROGRESS');
    expect(() => cache.acquireReplyAssist('two', 'assist', 'world')).toThrow('WORLD_UPDATE_IN_PROGRESS');
    expect(() => cache.assertWorldWrite('world', { ...permit })).toThrow('WORLD_UPDATE_IN_PROGRESS');
    expect(() => cache.assertWorldWrite('world', permit)).not.toThrow();
    expect(() => cache.assertSessionWrite('idle', undefined, 'world')).toThrow('SESSION_WRITE_LOCKED');
    expect(() => cache.assertStateWrite('idle', undefined, 'world')).toThrow('STATE_WRITE_LOCKED');
    expect(() => cache.assertGlobalStateWrite('world')).toThrow('STATE_WRITE_LOCKED');
    cache.releaseWorldUpdate({ ...permit });
    expect(() => cache.assertWorldRead('world')).toThrow('WORLD_UPDATE_IN_PROGRESS');
    expect(() => cache.assertWorldRead('another')).not.toThrow();
    cache.releaseWorldUpdate(permit);
    expect(() => cache.assertWorldWrite('world', permit)).toThrow('WORLD_UPDATE_IN_PROGRESS');
    expect(() => cache.acquireRun(owner)).not.toThrow();
  });

  it('invalidates earlier reads even if an update rolls back to the same database revision', () => {
    const cache = new RuntimeCache();
    const epoch = cache.captureWorldRead('world');
    const update = cache.acquireWorldUpdate('world');
    cache.releaseWorldUpdate(update);
    expect(() => cache.assertWorldRead('world', epoch)).toThrow('WORLD_REVISION_CONFLICT');
    expect(() => cache.assertWorldRead('world', cache.captureWorldRead('world'))).not.toThrow();
  });
});
