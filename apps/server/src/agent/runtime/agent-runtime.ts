import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ErrorCodes } from '../../common/error-codes.js';
import { debugLog } from '../../common/debug.js';
import type { CredentialStore } from '../../infrastructure/credentials/store.js';
import type { ModelGateway } from '../model/pi-gateway.js';
import { RuntimeError } from '../shared/errors.js';
import { RunStore } from '../persistence/run-store.js';
import { ModelClient } from '../model/model-client.js';
import { UsageStore, RunContext } from '../persistence/usage-store.js';
import { RunPostProcessor } from './run-post-processor.js';
import { ContextManager } from '../context/context-manager.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { AgentRunner } from './agent-runner.js';
import type { RunTask, RunEvent } from './types.js';

export { RuntimeError } from '../shared/errors.js';

/** Long-lived session coordinator. Model execution and database writes live elsewhere. */
export class AgentRuntime {
  private active = new Map<string, RunTask>();
  private deleting = new Set<string>();
  private deletingWorlds = new Set<string>();
  private worldRuns = new Map<string, string>();
  private listeners = new Set<RunEvent>();
  private store: RunStore;
  private context: ContextManager;
  private runner: AgentRunner;
  private usage: UsageStore;
  private postProcessor: RunPostProcessor;

  constructor(db: DatabaseSync, credentials: CredentialStore, gateway: ModelGateway) {
    this.store = new RunStore(db);
    this.usage = new UsageStore(db);
    this.postProcessor = new RunPostProcessor(this.usage, (sessionId, runId) =>
      this.emit(sessionId, 'usage.updated', { sessionId, runId }));
    const client = new ModelClient(gateway, this.usage);
    this.context = new ContextManager(this.store, credentials, client);
    this.runner = new AgentRunner(this.store, client, new ToolExecutor(),
      (sessionId, event, payload) => this.emit(sessionId, event, payload),
      this.usage, this.postProcessor);
  }
  onEvent(listener: RunEvent) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(sessionId: string, event: string, payload: Record<string, unknown>) {
    if (event !== 'message.delta') debugLog('会话 SSE', { sessionId, event, payload });
    for (const listener of this.listeners) listener(sessionId, event, payload);
  }
  worldBusy(worldId: string) { return this.worldRuns.has(worldId); }
  worldDeleting(id: string) { return this.deletingWorlds.has(id); }
  busy(sessionId: string) { return this.active.has(sessionId) || this.deleting.has(sessionId); }
  activeRun(sessionId: string) {
    const task = this.active.get(sessionId);
    return task ? { id: task.runId, status: task.status } : null;
  }

  start(sessionId: string, text: string, requestId: string, tip: string) {
    if (this.busy(sessionId)) throw new RuntimeError(ErrorCodes.SESSION_BUSY);
    const session = this.store.session(sessionId);
    if (!session) throw new RuntimeError(ErrorCodes.SESSION_NOT_FOUND);
    const worldId = String(session.world_id);
    if (this.worldBusy(worldId) || this.worldDeleting(worldId)) throw new RuntimeError(ErrorCodes.WORLD_BUSY);
    // Cheap synchronous preflight: do not acknowledge a run which cannot start.
    if (!session.preset_id) throw new RuntimeError(ErrorCodes.PRESET_NOT_SELECTED);
    const pending = this.prepare(sessionId, text, requestId, tip);
    const task = this.active.get(sessionId);
    if (!task) return pending.then(() => { throw new RuntimeError(ErrorCodes.SESSION_BUSY); });
    this.emit(sessionId, 'run.updated', { runId: task.runId, status: 'preparing' });
    void pending.then(async ({ stream }) => {
      const reader = stream.getReader();
      try { while (!(await reader.read()).done) { /* independently drain */ } }
      finally { reader.releaseLock(); }
    }).catch(error => this.emit(sessionId, 'run.updated', {
      runId: task.runId, status: 'failed',
      errorCode: error instanceof RuntimeError ? error.code : ErrorCodes.INVALID_REQUEST,
    }));
    return Promise.resolve({ runId: task.runId, requestId, status: 'preparing' });
  }

  async deleteWorld<T>(worldId: string, ids: () => string[], remove: () => T): Promise<T> {
    if (this.deletingWorlds.has(worldId)) throw new RuntimeError(ErrorCodes.WORLD_BUSY);
    this.deletingWorlds.add(worldId);
    try { return await this.deleteSessions(ids(), remove); }
    finally { this.deletingWorlds.delete(worldId); }
  }
  async deleteSessions<T>(sessionIds: string[], remove: () => T): Promise<T> {
    if (sessionIds.some(id => this.deleting.has(id))) throw new RuntimeError(ErrorCodes.SESSION_BUSY);
    for (const id of sessionIds) this.deleting.add(id);
    try {
      for (const id of sessionIds) {
        const task = this.active.get(id);
        if (task) await this.stop(id, task.runId);
      }
      return remove();
    } finally { for (const id of sessionIds) this.deleting.delete(id); }
  }
  async stop(sessionId: string, runId: string) {
    const task = this.active.get(sessionId);
    if (task?.runId === runId) {
      task.stopped = true;
      task.controller.abort();
      await task.done;
      return this.status(sessionId, runId) ?? { runId, status: 'stopped', tipEntryId: this.store.tip(sessionId) };
    }
    return this.status(sessionId, runId);
  }
  async stopActive(sessionId: string) {
    const task = this.active.get(sessionId);
    return task ? this.stop(sessionId, task.runId) : null;
  }
  status(sessionId: string, runId: string) {
    const stored = this.store.status(sessionId, runId);
    if (stored) return stored;
    const task = this.active.get(sessionId);
    return task?.runId === runId ? { runId, status: task.status } : null;
  }

  async prepare(sessionId: string, input: string, requestId: string, expectedTip: string, clientSignal?: AbortSignal):
    Promise<{ runId: string; stream: ReadableStream<Uint8Array> }> {
    if (this.deleting.has(sessionId)) throw new RuntimeError(ErrorCodes.SESSION_BUSY);
    const running = this.active.get(sessionId);
    if (running) {
      if (running.requestId === requestId) throw new RuntimeError(ErrorCodes.REQUEST_ALREADY_EXISTS, { runId: running.runId });
      throw new RuntimeError(ErrorCodes.SESSION_BUSY);
    }
    const worldId = this.store.worldId(sessionId);
    if (!worldId) throw new RuntimeError(ErrorCodes.SESSION_NOT_FOUND);
    if (this.worldRuns.has(worldId) || this.deletingWorlds.has(worldId)) throw new RuntimeError(ErrorCodes.WORLD_BUSY);

    const runId = randomUUID(), controller = new AbortController();
    const session = this.store.session(sessionId);
    // Preserve existing run preflight semantics; don't create a pending journal for a rejected request.
    if (this.store.duplicate(sessionId, requestId)) throw new RuntimeError(ErrorCodes.REQUEST_ALREADY_EXISTS);
    if (this.store.tip(sessionId) !== expectedTip) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
    const runContext = new RunContext(sessionId, runId, String(session?.api_model_config_id ?? ''));
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const task: RunTask = { runId, requestId, controller, done, finish, stopped: false, status: 'preparing' };
    this.active.set(sessionId, task);
    this.worldRuns.set(worldId, sessionId);
    const disconnected = () => { task.stopped = true; controller.abort(); task.drain?.(); };
    clientSignal?.addEventListener('abort', disconnected, { once: true });
    if (clientSignal?.aborted) disconnected();
    const originalFinish = task.finish;
    task.finish = () => { clientSignal?.removeEventListener('abort', disconnected); originalFinish(); };
    const release = () => {
      this.active.delete(sessionId);
      this.worldRuns.delete(worldId);
      task.finish();
    };

    try {
      this.usage.beginRun(sessionId, runId, requestId);
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      const prepared = await this.context.prepare({
        sessionId, input, runId, requestId, expectedTip, signal: controller.signal, runContext,
      });
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      const userId = randomUUID();
      this.store.startRun({
        sessionId, expectedTip, runId, userId, input, requestId,
        summary: prepared.summary, generation: prepared.summaryGeneration, diagnostics: prepared.diagnostics,
      });
      try { this.usage.attachCompaction(sessionId, runId); }
      catch (error) { debugLog('摘要统计关联失败', { sessionId, runId, error: String(error) }); }
      task.status = 'running';
      this.emit(sessionId, 'run.updated', { runId, status: 'running', tipEntryId: userId });
      this.emit(sessionId, 'message.created', {
        runId, message: { id: userId, role: 'user', text: input, status: 'completed', createdAt: Date.now() },
      });
      const stream = new ReadableStream<Uint8Array>({
        start: streamController => {
          void this.runner.execute({ sessionId, runId, userId, prepared, task, runContext, streamController, release });
        },
        pull: () => { task.drain?.(); },
        cancel: () => { task.stopped = true; task.controller.abort(); task.drain?.(); },
      });
      return { runId, stream };
    } catch (error) {
      try { this.postProcessor.process(runContext, 'failed'); }
      catch (postError) { debugLog('Run 后置处理失败', { sessionId, runId, error: String(postError) }); }
      finally { release(); }
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      throw error;
    }
  }
}
