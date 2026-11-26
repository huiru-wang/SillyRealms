import { AppError } from '../../errors.js';

/** Identity-based capabilities remain inside the server process. */
export type RunWritePermit = Readonly<{ sessionId: string; worldId: string; runId: string }>;
export type WorldUpdatePermit = Readonly<{ worldId: string }>;
type ReplyAssistPermit = Readonly<{ sessionId: string; worldId: string; requestId: string }>;

/** Application-wide, single-process admission. No persisted or distributed locks. */
export class RuntimeCache {
  readonly #runs = new Map<string, RunWritePermit>();
  readonly #assists = new Map<string, ReplyAssistPermit>();
  readonly #worldUpdates = new Map<string, WorldUpdatePermit>();
  readonly #worldReadEpochs = new Map<string, number>();

  acquireReplyAssist(sessionId: string, requestId: string, worldId: string): ReplyAssistPermit {
    this.assertWorldWrite(worldId);
    if (this.#runs.has(sessionId)) throw new AppError('RUN_ALREADY_ACTIVE');
    if (this.#assists.has(sessionId)) throw new AppError('REPLY_ASSIST_ALREADY_ACTIVE');
    const owner = Object.freeze({ sessionId, requestId, worldId });
    this.#assists.set(sessionId, owner);
    return owner;
  }

  releaseReplyAssist(owner: ReplyAssistPermit): void {
    if (this.#assists.get(owner.sessionId) === owner) this.#assists.delete(owner.sessionId);
  }

  acquireRun(owner: RunWritePermit): RunWritePermit {
    this.assertWorldWrite(owner.worldId);
    if (this.#runs.has(owner.sessionId)) throw new AppError('RUN_ALREADY_ACTIVE');
    if (this.#assists.has(owner.sessionId)) throw new AppError('REPLY_ASSIST_ALREADY_ACTIVE');
    const permit = Object.freeze({ ...owner });
    this.#runs.set(owner.sessionId, permit);
    return permit;
  }

  releaseRun(permit: RunWritePermit): void {
    if (this.#runs.get(permit.sessionId) === permit) this.#runs.delete(permit.sessionId);
  }

  assertWorldUpdateAvailable(worldId: string): void {
    if (this.#worldUpdates.has(worldId)
      || [...this.#runs.values()].some(run => run.worldId === worldId)
      || [...this.#assists.values()].some(assist => assist.worldId === worldId)) {
      throw new AppError('WORLD_UPDATE_BUSY');
    }
  }

  acquireWorldUpdate(worldId: string): WorldUpdatePermit {
    this.assertWorldUpdateAvailable(worldId);
    const permit = Object.freeze({ worldId });
    this.#worldUpdates.set(worldId, permit);
    this.#worldReadEpochs.set(worldId, (this.#worldReadEpochs.get(worldId) ?? 0) + 1);
    return permit;
  }

  releaseWorldUpdate(permit: WorldUpdatePermit): void {
    if (this.#worldUpdates.get(permit.worldId) === permit) this.#worldUpdates.delete(permit.worldId);
  }

  captureWorldRead(worldId: string): number {
    this.assertWorldRead(worldId);
    return this.#worldReadEpochs.get(worldId) ?? 0;
  }

  assertWorldRead(worldId: string, expectedEpoch?: number): void {
    if (this.#worldUpdates.has(worldId)) throw new AppError('WORLD_UPDATE_IN_PROGRESS');
    if (expectedEpoch !== undefined && expectedEpoch !== (this.#worldReadEpochs.get(worldId) ?? 0)) {
      throw new AppError('WORLD_REVISION_CONFLICT');
    }
  }

  assertWorldWrite(worldId: string, permit?: WorldUpdatePermit): void {
    const owner = this.#worldUpdates.get(worldId);
    if (permit === undefined ? owner !== undefined : owner !== permit || permit.worldId !== worldId) {
      throw new AppError('WORLD_UPDATE_IN_PROGRESS');
    }
  }

  assertSessionWrite(sessionId: string, permit?: RunWritePermit, worldId?: string): void {
    if (worldId && this.#worldUpdates.has(worldId)) throw new AppError('SESSION_WRITE_LOCKED');
    this.#assertWrite(sessionId, permit, 'SESSION_WRITE_LOCKED');
  }

  assertStateWrite(sessionId: string, permit?: RunWritePermit, worldId?: string): void {
    if (worldId && this.#worldUpdates.has(worldId)) throw new AppError('STATE_WRITE_LOCKED');
    this.#assertWrite(sessionId, permit, 'STATE_WRITE_LOCKED');
  }

  assertGlobalStateWrite(worldId: string): void {
    if (this.#worldUpdates.has(worldId)) throw new AppError('STATE_WRITE_LOCKED');
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
