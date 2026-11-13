import { isDeepStrictEqual } from 'node:util';
import { validateSnapshot } from '../domain/state/state.js';
import { resolveRuntimeConfig, publicCapabilities } from './config.js';
import { initialExtensions, rejectExtensions } from './narrative/extension-contract.js';
import { DirectRunner } from './runners/direct-runner.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ErrorCodes, normalizeError } from '../common/error-codes.js';
import { debugLog } from '../common/debug.js';
import type { CredentialStore } from '../infrastructure/credentials/store.js';
import type { ModelGateway } from './model/pi-gateway.js';
import { RuntimeError } from './shared/errors.js';
import { RunStore } from './persistence/run-store.js';
import { ModelClient } from './model/model-client.js';
import { UsageStore, RunAccounting } from './persistence/usage-store.js';
import { RunPostProcessor } from './persistence/run-post-processor.js';
import { ContextManager } from './context/context-manager.js';
import { ToolExecutor } from './tools/tool-executor.js';
import { AgentRunner } from './runners/agent-runner.js';
import type { RunTask, RunEvent, RunnerArgs, RunnerResult } from './types.js';

export { RuntimeError } from './shared/errors.js';

/** Long-lived session coordinator. Model execution and database writes live elsewhere. */
export class SRRuntime {
  private active = new Map<string, RunTask>();
  private deleting = new Set<string>();
  private deletingWorlds = new Set<string>();
  private worldRuns = new Map<string, string>();
  private listeners = new Set<RunEvent>();
  private store: RunStore;
  private context: ContextManager;
  private runner: AgentRunner;
  private direct: DirectRunner;
  private client: ModelClient;
  private usage: UsageStore;
  private postProcessor: RunPostProcessor;

  constructor(db: DatabaseSync, credentials: CredentialStore, gateway: ModelGateway) {
    this.store = new RunStore(db);
    this.usage = new UsageStore(db);
    this.postProcessor = new RunPostProcessor(this.usage, (sessionId, runId) =>
      this.emit(sessionId, 'usage.updated', { sessionId, runId }));
    const client = this.client = new ModelClient(gateway, this.usage, credentials);
    this.context = new ContextManager(this.store, client);
    this.runner = new AgentRunner(this.store, client, new ToolExecutor(),
      (sessionId, event, payload) => this.emit(sessionId, event, payload),
      this.usage, this.context);
    this.direct = new DirectRunner(this.store, client, this.usage, (id, event, payload) => this.emit(id, event, payload));
  }
  onEvent(listener: RunEvent) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(sessionId: string, event: string, payload: Record<string, unknown>) {
    if (event !== 'message.delta') debugLog('会话 SSE', { sessionId, event, runId: payload.runId });
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
    return task ? { id: task.runId, status: task.status, phase: task.phase ?? 'preparing', executionMode: task.config?.execution.mode, capabilities: task.capabilities } : null;
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
  status(sessionId: string, runId: string) {
    const stored = this.store.status(sessionId, runId);
    const task = this.active.get(sessionId);
    if (stored) return task?.runId === runId && stored.status === 'running' ? { ...stored, phase: task.phase } : stored;
    return task?.runId === runId ? { runId, status: task.status, phase: task.phase ?? 'preparing', executionMode: task.config?.execution.mode, capabilities: task.capabilities } : null;
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

    try {
      this.usage.beginRun(sessionId, runId, requestId);
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      const config = resolveRuntimeConfig(this.store, this.client, sessionId);
      task.config = config;
      task.capabilities = publicCapabilities(config);
      const prepared = await this.context.prepare({
        sessionId, input, runId, requestId, expectedTip, signal: controller.signal, runContext, config,
      });
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      const userId = randomUUID();
      this.store.startRun({
        sessionId, expectedTip, runId, userId, input, requestId,
        summary: prepared.summary, generation: prepared.summaryGeneration, diagnostics: prepared.diagnostics,
        publicRun: { executionMode: config.execution.mode, phase: 'narrative',
          capabilities: publicCapabilities(config, prepared.active),
          ...(config.execution.mode === 'direct' ? { extensions: initialExtensions(config.extensions, prepared.active) } : {}) },
        runtimeSnapshot: { version: config.version, mode: config.execution.mode, presetId: config.preset.id,
          presetHash: config.preset.hash, modelId: config.model.definition.id, configId: config.model.configId,
          contextPolicy: config.contextPolicy, capabilityRevision: config.capabilityRevision,
          extensions: config.extensions, baselineHash: prepared.execution.state.baselineHash,
          active: [...prepared.active], budget: prepared.execution.request?.report },
      });
      try { this.usage.attachCompaction(sessionId, runId); }
      catch (error) { debugLog('摘要统计关联失败', { sessionId, runId, errorCode: normalizeError(error).errorCode }); }
      prepared.execution.progress.latestEntryId = userId;
      prepared.execution.progress.pendingSummary = undefined;
      task.status = 'running';
      task.phase = prepared.execution.progress.phase = 'narrative';
      task.capabilities = publicCapabilities(config, prepared.active);
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
      try { this.postProcessor.process(runContext, task.stopped ? 'stopped' : 'failed'); }
      catch (postError) { debugLog('Run 后置处理失败', { sessionId, runId, errorCode: normalizeError(postError).errorCode }); }
      finally { release(); }
      this.emit(sessionId, 'run.updated', { runId, status: task.stopped ? 'stopped' : 'failed',
        phase: 'finalized', executionMode: task.config?.execution.mode, capabilities: task.capabilities,
        ...(!task.stopped ? normalizeError(error) : {}) });
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      throw error;
    }
  }

  private async executeRun(args: RunnerArgs, release: () => void): Promise<void> {
    let result: RunnerResult;
    try {
      result = await (args.prepared.config.execution.mode === 'direct' ? this.direct : this.runner).execute(args);
    } catch (error) {
      result = { outcome: args.task.stopped ? 'stopped' : 'failed',
        failure: args.task.stopped ? null : normalizeError(error),
        partialId: null, workspace: structuredClone(args.prepared.execution.state.baseline) };
    }
    try { this.finishRun(args, result); }
    finally {
      try { args.streamController.close(); } catch { /* consumer disconnected */ }
      release();
    }
  }

  /** The only finalization and Run-level settlement path. No await between cancellation and commit. */
  private finishRun(args: RunnerArgs, candidate: RunnerResult): void {
    const { prepared, sessionId, runId, userId, task, runContext } = args;
    const { execution, config } = prepared;
    let result = candidate;
    if (task.stopped) result = { ...result, outcome: 'stopped', failure: null,
      ...(result.extensions ? { extensions: rejectExtensions(result.extensions, true) } : {}) };
    let allowState = config.execution.mode === 'agent' ? result.outcome !== 'failed'
      : result.outcome === 'completed' && !!result.extensions &&
        ['applied', 'unchanged', 'partial'].includes(result.extensions.stateUpdate.status);
    const publicFields = () => ({ executionMode: config.execution.mode, phase: 'finalized',
      capabilities: task.capabilities, ...(result.extensions ? { extensions: result.extensions } : {}) });
    let committed = false;
    let stage: 'validation' | 'commit' = 'validation';
    try {
      if (allowState) validateSnapshot(prepared.worldState, 'message', result.workspace);
      stage = 'commit';
      committed = this.store.finalize(sessionId, userId, result.partialId, result.outcome, result.workspace, result.failure, {
        expectedTip: execution.progress.latestEntryId, baselineHash: execution.state.baselineHash,
        allowState, publicRun: publicFields(), diagnostics: { extensions: result.diagnostics, budgetReports: execution.progress.budgetReports, summaryCalls: execution.progress.summaryCalls },
        summary: result.outcome === 'stopped' ? undefined : execution.progress.pendingSummary,
      });
      if (!committed) return; // The stored terminal result already won; never notify or settle twice.
    } catch (error) {
      allowState = false;
      const failure = normalizeError(error, stage === 'validation' ? ErrorCodes.INVALID_STATE_UPDATE : ErrorCodes.STATE_COMMIT_FAILED);
      result = { ...result, outcome: 'failed', failure,
        ...(result.extensions ? { extensions: rejectExtensions(result.extensions, false, failure.errorCode) } : {}) };
      try { if (!this.store.markCommitFailed(userId, failure, publicFields())) debugLog('终态未持久化，等待中断恢复', { sessionId, runId }); }
      catch { debugLog('终态持久化失败，等待中断恢复', { sessionId, runId, errorCode: failure.errorCode }); }
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
  }

}
