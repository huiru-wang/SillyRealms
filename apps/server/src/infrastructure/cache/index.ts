import { AppError } from '../../errors.js';

/** An identity-based capability held only by the run that acquired the lock. */
export type RunWritePermit = Readonly<{ sessionId: string; worldId: string; runId: string }>;

/** Application-wide, single-process runtime cache. No persisted or distributed locks. */
export class RuntimeCache {
  readonly #runs = new Map<string, RunWritePermit>();

  readonly #assists = new Map<string, Readonly<{ sessionId: string; requestId: string }>>();

  acquireReplyAssist(sessionId: string, requestId: string) {
    if (this.#runs.has(sessionId)) throw new AppError('RUN_ALREADY_ACTIVE');
    if (this.#assists.has(sessionId)) throw new AppError('REPLY_ASSIST_ALREADY_ACTIVE');
    const owner = Object.freeze({ sessionId, requestId });
    this.#assists.set(sessionId, owner);
    return owner;
  }

  releaseReplyAssist(owner: Readonly<{ sessionId: string; requestId: string }>) {
    if (this.#assists.get(owner.sessionId) === owner) this.#assists.delete(owner.sessionId);
  }

  acquireRun(owner: RunWritePermit): RunWritePermit {
    if (this.#runs.has(owner.sessionId)) throw new AppError('RUN_ALREADY_ACTIVE');
    if (this.#assists.has(owner.sessionId)) throw new AppError('REPLY_ASSIST_ALREADY_ACTIVE');
    const permit = Object.freeze({ ...owner });
    this.#runs.set(owner.sessionId, permit);
    return permit;
  }

  releaseRun(permit: RunWritePermit): void {
    // A delayed finalizer must never release a newer run's lock.
    if (this.#runs.get(permit.sessionId) === permit) this.#runs.delete(permit.sessionId);
  }

  assertSessionWrite(sessionId: string, permit?: RunWritePermit): void {
    this.#assertWrite(sessionId, permit, 'SESSION_WRITE_LOCKED');
  }

  assertStateWrite(sessionId: string, permit?: RunWritePermit): void {
    this.#assertWrite(sessionId, permit, 'STATE_WRITE_LOCKED');
  }

  assertGlobalStateWrite(worldId: string): void {
    for (const permit of this.#runs.values()) {
      if (permit.worldId === worldId) throw new AppError('STATE_WRITE_LOCKED');
    }
  }

  #assertWrite(sessionId: string, permit: RunWritePermit | undefined, code: 'SESSION_WRITE_LOCKED' | 'STATE_WRITE_LOCKED'): void {
    if (this.#assists.has(sessionId)) throw new AppError(code);
    const owner = this.#runs.get(sessionId);
    if (permit === undefined ? owner !== undefined : owner !== permit || permit.sessionId !== sessionId) {
      throw new AppError(code);
    }
  }
}
