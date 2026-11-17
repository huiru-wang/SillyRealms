import { historyRuns } from '../domain/session/history-runs.js';
import { isDeepStrictEqual } from 'node:util';
import { validateSnapshot } from '../domain/state/state.js';
import { resolveRuntimeConfig } from './config.js';
import { initialExtensions, rejectExtensions, persistableExtensions } from './postprocess/contracts.js';
import { DirectRunner } from './runners/direct-runner.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { stateErrorDetails, ErrorCodes, normalizeError } from '../common/error-codes.js';
import { debugEnabled, debugLog, withDebugContext } from '../common/debug.js';
import type { CredentialStore } from '../infrastructure/credentials/store.js';
import type { ModelGateway } from './model/pi-gateway.js';
import { RuntimeError } from './shared/errors.js';
import { RunStore } from './persistence/run-store.js';
import { ModelClient } from './model/model-client.js';
import { UsageStore, RunAccounting } from './persistence/usage-store.js';
import { RunPostProcessor } from './persistence/run-post-processor.js';
import { ContextManager } from './context/context-manager.js';
import type { RunTask, RunEvent, RunnerArgs, RunnerResult } from './types.js';

export { RuntimeError } from './shared/errors.js';

/** Long-lived session coordinator. Model execution and database writes live elsewhere. */
export class SRRuntime {
  private active = new Map<string, RunTask>();
  private deleting = new Set<string>();
  private deletingWorlds = new Set<string>();
  private worldRuns = new Map<string, string>();
  private listeners = new Set<RunEvent>();
  private closing = false;
  private store: RunStore;
  private context: ContextManager;
  private direct: DirectRunner;
  private client: ModelClient;
  private usage: UsageStore;
  private postProcessor: RunPostProcessor;

  constructor(private db: DatabaseSync, credentials: CredentialStore, gateway: ModelGateway) {
    this.store = new RunStore(db);
    this.usage = new UsageStore(db);
    this.postProcessor = new RunPostProcessor(this.usage, (sessionId, runId) =>
      this.emit(sessionId, 'usage.updated', { sessionId, runId }));
    const client = this.client = new ModelClient(gateway, this.usage, credentials);
    this.context = new ContextManager(this.store, client);
    this.direct = new DirectRunner(this.store, client, this.usage, (id, event, payload) => this.emit(id, event, payload));
  }
  onEvent(listener: RunEvent) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(sessionId: string, event: string, payload: Record<string, unknown>) {
    if (event !== 'message.delta') debugLog('EVENT', { sessionId, event, runId: payload.runId, status: payload.status, phase: payload.phase,
      errorCode: payload.errorCode, messageId: payload.messageId, offset: payload.offset,
      ...(typeof payload.text === 'string' ? { textLength: payload.text.length } : {}) });
    for (const listener of this.listeners) {
      try { listener(sessionId, event, payload); }
      catch { /* Notifications cannot roll back committed state or retain a run lock. */ }
    }
  }
  worldBusy(worldId: string) { return this.worldRuns.has(worldId); }
  worldDeleting(id: string) { return this.deletingWorlds.has(id); }
  busy(sessionId: string) { return this.active.has(sessionId) || this.deleting.has(sessionId); }
  activeRun(sessionId: string) {
    const task = this.active.get(sessionId);
    return task ? { id: task.runId, status: task.status, phase: task.phase ?? 'preparing' } : null;
  }

  start(sessionId: string, text: string, requestId: string, tip: string) {
    if (this.closing) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
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
    this.emit(sessionId, 'run.phase', { runId: task.runId, phase: 'preparing' });
    void pending.then(async ({ stream }) => {
      const reader = stream.getReader();
      try { while (!(await reader.read()).done) { /* independently drain */ } }
      finally { reader.releaseLock(); }
    }).catch(() => { /* prepare owns failure notification and settlement. */ });
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
  async shutdown(): Promise<void> {
    this.closing = true;
    const tasks = [...this.active.values()];
    for (const task of tasks) {
      task.stopped = true;
      task.controller.abort();
      task.drain?.();
    }
    await Promise.all(tasks.map(task => task.done));
  }
  status(sessionId: string, runId: string) {
    const stored = this.store.status(sessionId, runId);
    const task = this.active.get(sessionId);
    if (stored) return task?.runId === runId && ['preparing', 'running'].includes(stored.status) ? { ...stored, messages: [...(stored.messages ?? []), ...(task.liveMessage ? [{ ...task.liveMessage }] : [])], phase: task.phase ?? 'preparing' } : stored;
    return task?.runId === runId ? { runId, messages: task.liveMessage ? [{ ...task.liveMessage }] : [], status: task.status, phase: task.phase ?? 'preparing' } : null;
  }

  history(sessionId: string, tip: string, limit: number, cursor?: string) {
    const page = historyRuns(this.db, sessionId, tip, limit, cursor);
    const task = this.active.get(sessionId);
    if (!cursor && task) {
      const current = this.status(sessionId, task.runId);
      if (current) {
        const { input: _input, ...snapshot } = current as Record<string, any>;
        const run = { ...snapshot, status: String(current.status), id: task.runId, messages: current.messages ?? [] };
        const index = page.runs.findIndex(item => item.id === task.runId);
        if (index >= 0) page.runs[index] = run;
        else page.runs.push(run);
      }
    }
    return page;
  }

  prepare(sessionId: string, input: string, requestId: string, expectedTip: string, clientSignal?: AbortSignal) {
    const runId = randomUUID();
    return withDebugContext({ sessionId, runId }, () => this.prepareRun(runId, sessionId, input, requestId, expectedTip, clientSignal));
  }

  private logRunEnd(sessionId: string, runId: string, runContext: RunAccounting): void {
    if (!debugEnabled()) return;
    try {
      const result = this.store.status(sessionId, runId);
      debugLog('RUN END', { sessionId, runId, status: result?.status ?? 'unpersisted',
        errorCode: result?.errorCode, durationMs: runContext.durationMs() });
    } catch { debugLog('RUN END', { sessionId, runId, status: 'unpersisted', durationMs: runContext.durationMs() }); }
  }

  private async prepareRun(runId: string, sessionId: string, input: string, requestId: string, expectedTip: string, clientSignal?: AbortSignal):
    Promise<{ runId: string; stream: ReadableStream<Uint8Array> }> {
    if (this.closing) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
    if (this.deleting.has(sessionId)) throw new RuntimeError(ErrorCodes.SESSION_BUSY);
    const running = this.active.get(sessionId);
    if (running) {
      if (running.requestId === requestId) throw new RuntimeError(ErrorCodes.REQUEST_ALREADY_EXISTS, { runId: running.runId });
      throw new RuntimeError(ErrorCodes.SESSION_BUSY);
    }
    const worldId = this.store.worldId(sessionId);
    if (!worldId) throw new RuntimeError(ErrorCodes.SESSION_NOT_FOUND);
    if (this.worldRuns.has(worldId) || this.deletingWorlds.has(worldId)) throw new RuntimeError(ErrorCodes.WORLD_BUSY);

    const controller = new AbortController();
    const session = this.store.session(sessionId);
    // Preserve existing run preflight semantics; don't create a pending journal for a rejected request.
    if (this.store.duplicate(sessionId, requestId)) throw new RuntimeError(ErrorCodes.REQUEST_ALREADY_EXISTS);
    if (this.store.tip(sessionId) !== expectedTip) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
    const runContext = new RunAccounting(sessionId, runId, String(session?.api_model_config_id ?? ''));
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const task: RunTask = { runId, requestId, controller, done, finish, stopped: false, status: 'preparing', phase: 'preparing' };
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

    let accepted = false;
    try {
      this.store.beginPreparation({ sessionId, runId, requestId, expectedTip, input }, () => this.usage.beginRun(sessionId, runId, requestId));
      accepted = true;
      debugLog('RUN BEGIN', { sessionId, runId, requestId, expectedTipEntryId: expectedTip });
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      const config = resolveRuntimeConfig(this.store, this.client, sessionId);
      const prepared = await this.context.prepare({
        sessionId, input, runId, requestId, expectedTip, signal: controller.signal, runContext, config,
      });
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      const userId = randomUUID();
      this.store.startRun({
        sessionId, expectedTip, runId, userId, input, requestId,
        summary: prepared.summary,
        publicRun: { extensions: persistableExtensions(initialExtensions(prepared.postprocess)) },
      });
      try { this.usage.attachCompaction(sessionId, runId); }
      catch (error) { debugLog('摘要统计关联失败', { sessionId, runId, errorCode: normalizeError(error).errorCode }); }
      prepared.execution.progress.latestEntryId = userId;
      task.status = 'running';
      task.phase = prepared.execution.progress.phase = 'narrative';
      this.emit(sessionId, 'run.updated', { runId, status: 'running', tipEntryId: userId });
      this.emit(sessionId, 'message.created', {
        runId, message: { id: userId, role: 'user', text: input, status: 'completed', createdAt: Date.now() },
      });
      this.emit(sessionId, 'run.phase', { runId, phase: 'narrative' });
      const stream = new ReadableStream<Uint8Array>({
        start: streamController => {
          void this.executeRun({ sessionId, runId, userId, prepared, task, runContext, streamController }, release);
        },
        pull: () => { task.drain?.(); },
        cancel: () => { task.stopped = true; task.controller.abort(); task.drain?.(); },
      });
      return { runId, stream };
    } catch (error) {
      // A persisted acceptance can report even an immediate configuration failure as an asynchronous Run terminal.
      if (accepted) await Promise.resolve();
      const failure = normalizeError(error);
      const terminal = { runId, status: task.stopped ? 'stopped' : 'failed', phase: 'finalized',
        ...(task.stopped ? {} : failure) };
      let settled = false;
      try { if (accepted) settled = this.postProcessor.process(runContext, task.stopped ? 'stopped' : 'failed', terminal); }
      catch (postError) { debugLog('Run 后置处理失败', { sessionId, runId, errorCode: normalizeError(postError).errorCode }); }
      finally { release(); }
      if (settled) this.emit(sessionId, 'run.updated', terminal);
      if (accepted) this.logRunEnd(sessionId, runId, runContext);
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      throw error;
    }
  }

  private async executeRun(args: RunnerArgs, release: () => void): Promise<void> {
    let result: RunnerResult;
    try {
      result = await this.direct.execute(args);
    } catch (error) {
      result = { outcome: args.task.stopped ? 'stopped' : 'failed',
        failure: args.task.stopped ? null : normalizeError(error),
        partialId: null, workspace: structuredClone(args.prepared.execution.state.baseline) };
    }
    try { this.finishRun(args, result); }
    finally {
      try { args.streamController.close(); } catch { /* consumer disconnected */ }
      release();
      this.logRunEnd(args.sessionId, args.runId, args.runContext);
    }
  }

  /** The only finalization and Run-level settlement path. No await between cancellation and commit. */
  private finishRun(args: RunnerArgs, candidate: RunnerResult): void {
    const { prepared, sessionId, runId, userId, task, runContext } = args;
    const { execution } = prepared;
    let result = candidate;
    if (task.stopped) result = { ...result, outcome: 'stopped', failure: null,
      ...(result.extensions ? { extensions: rejectExtensions(result.extensions, true) } : {}) };
    let allowState = result.outcome === 'completed' && !!result.extensions &&
        ['applied', 'unchanged', 'partial'].includes(result.extensions.stateUpdate.status);
    if (allowState) {
      try { validateSnapshot(prepared.worldState, 'message', result.workspace); }
      catch(error) {
        allowState = false;
        const failure=normalizeError(error,ErrorCodes.INVALID_STATE_UPDATE), detail=stateErrorDetails(error);
        const diagnostic={scope:'message' as const,errorCode:failure.errorCode,
          ...(detail?{statePath:detail.path,...(detail.rulePath?{rulePath:detail.rulePath}:{})}:{})};
        debugLog('状态快照校验失败',{sessionId,runId,diagnostic});
        result = { ...result, workspace: structuredClone(execution.state.baseline),
          extensions: { ...result.extensions!, stateUpdate: { status: 'failed', errorCode: failure.errorCode, diagnostics:[diagnostic] } } };
      }
    }
    const publicFields = () => ({ phase: 'finalized',
      ...(result.extensions ? { extensions: persistableExtensions(result.extensions) } : {}) });
    let committed = false;
    try {
      committed = this.store.finalize(sessionId, userId, result.outcome, result.workspace, result.failure, {
        expectedTip: execution.progress.latestEntryId, baselineHash: execution.state.baselineHash,
        allowState, pendingMessage: task.liveMessage, publicRun: publicFields(),
      });
      if (!committed) return; // The stored terminal result already won; never notify or settle twice.
    } catch (error) {
      allowState = false;
      const failure = normalizeError(error, ErrorCodes.STATE_COMMIT_FAILED);
      result = { ...result, outcome: 'failed', failure,
        ...(result.extensions ? { extensions: rejectExtensions(result.extensions, false, failure.errorCode) } : {}) };
      let saved = false;
      try { saved = this.store.markCommitFailed(userId, failure, publicFields()); }
      catch { /* Preserve the journal for interruption recovery. */ }
      if (!saved) {
        debugLog('终态未持久化，等待中断恢复', { sessionId, runId, errorCode: failure.errorCode });
        return;
      }
    }
    task.phase = execution.progress.phase = 'finalized';
    if (result.partialId) this.emit(sessionId, 'message.final', { runId, messageId: result.partialId, status: result.outcome });
    if (committed && allowState) {
      for (const [path, value] of Object.entries(result.workspace)) {
        if (!isDeepStrictEqual(execution.state.baseline[path], value))
          this.emit(sessionId, 'state.changed', { path, scope: 'message', value });
      }
    }
    try { this.usage.attachCompaction(sessionId, runId); }
    catch (error) { debugLog('摘要用量关联失败', { sessionId, runId, errorCode: normalizeError(error).errorCode }); }
    try { this.postProcessor.process(runContext, result.outcome); }
    catch (error) { debugLog('Run 用量结算失败', { sessionId, runId, errorCode: normalizeError(error).errorCode }); }
    let tipEntryId: string | null = execution.progress.latestEntryId ?? userId;
    try { tipEntryId = this.store.tip(sessionId); } catch { /* Already committed outcome remains authoritative. */ }
    this.emit(sessionId, 'run.updated', { runId, status: result.outcome,
      tipEntryId, ...publicFields(), ...(result.failure ?? {}) });
    if(committed&&result.outcome==='completed'&&result.partialId&&result.extensions?.actionSuggestions.status==='ready'){
      this.emit(sessionId,'action_suggestions.changed',{sessionId,suggestions:{runId,messageId:result.partialId,items:result.extensions.actionSuggestions.items}});
    }
  }

}
