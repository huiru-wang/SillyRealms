import type { Context, ToolChoice } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../common/error-codes.js';
import { decodeMessageState, validateSnapshot, type Json } from '../../domain/state/state.js';
import { storedError } from '../../domain/world-card.js';
import { readWorld } from '../../repositories/world-repository.js';
import { buildContext, estimateNarrativeItemSize, estimateMessageBytes } from './prompt-builder.js';
import { compressHistory, summarizeInBudget, type HistoryItem } from './history-compactor.js';
import { stateTool } from '../tools/state-tool.js';
import { RuntimeError } from '../shared/errors.js';
import type { PreparedRun, RuntimeConfig, ExecutionContext } from '../types.js';
import type { RunStore } from '../persistence/run-store.js';
import type { ModelClient } from '../model/model-client.js';
import type { ContextComposition, RunAccounting, SessionUsage } from '../persistence/usage-store.js';
import { deepFreeze, fingerprint, CONTEXT_WINDOWS } from '../config.js';
import { evaluateBudget, requireMeasured, type PreparedRequest, type BudgetReport } from './budget.js';
import { requiredToolChoice } from '../model/pi-gateway.js';

export { summaryNarrative } from './history-compactor.js';
/** Historical policy retained for migration/regression evidence, never a current_request fallback. */
export function contextTriggerThreshold(strategy: keyof typeof CONTEXT_WINDOWS, modelWindow: number, output: number): number {
  return Math.min(CONTEXT_WINDOWS[strategy], modelWindow) - output - 1024 - 2048;
}
export function shouldCompactPreviousUsage(snapshot: SessionUsage['latestContext'], modelId: string,
  configId: string, threshold: number): boolean {
  return !snapshot || snapshot.outputTokens === undefined || snapshot.modelId !== modelId ||
    snapshot.apiModelConfigId !== configId || snapshot.inputTokens + snapshot.outputTokens >= threshold;
}
export function estimateContextComposition(context: ReturnType<typeof buildContext>, history: HistoryItem[], input: string): ContextComposition {
  const systemMessages = context.trace([]).filter(row => row.nodeId !== 'chatHistory' && row.nodeId !== 'userInput')
    .flatMap(row => row.messages);
  const summary = history.find(item => item.id === 'summary');
  return { systemBytes: estimateMessageBytes(systemMessages),
    summaryBytes: summary ? estimateNarrativeItemSize(summary) : 0,
    historyBytes: history.filter(item => item.id !== 'summary').reduce((sum, item) => sum + estimateNarrativeItemSize(item), 0)
      + estimateNarrativeItemSize({ role: 'user', text: input }) };
}

/** Shared content preparation. Frozen config enters here; no configuration re-read or state writes. */
export class ContextManager {
  constructor(private store: RunStore, private client: ModelClient) {}

  async prepare(args: {
    sessionId: string; input: string; runId: string; requestId: string; expectedTip: string;
    signal: AbortSignal; runContext: RunAccounting; config: RuntimeConfig;
  }): Promise<PreparedRun> {
    const { sessionId, input, runId, requestId, expectedTip, signal, config } = args;
    const session = this.store.session(sessionId);
    if (!session) throw new RuntimeError(ErrorCodes.SESSION_NOT_FOUND);
    if (this.store.duplicate(sessionId, requestId)) throw new RuntimeError(ErrorCodes.REQUEST_ALREADY_EXISTS);
    if (session.tip_entry_id !== expectedTip) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
    const model = config.model.definition;
    if (config.execution.mode === 'direct' && !this.client.supportsDirect(model))
      throw new RuntimeError(ErrorCodes.NARRATIVE_SYSTEM_ORDER_UNSUPPORTED);
    const worldRow = this.store.world(String(session.world_id));
    if (!worldRow) throw new RuntimeError(ErrorCodes.WORLD_NOT_FOUND);
    let world: ReturnType<typeof readWorld>['data'];
    try { world = readWorld(worldRow).data; }
    catch (error) { throw new RuntimeError(ErrorCodes.WORLD_CORRUPT, storedError(error).details); }
    const chain = this.store.ancestors(sessionId, expectedTip);
    const stateRow = [...chain].reverse().find(row => row.state !== null);
    let messageState: Record<string, Json>;
    try { messageState = decodeMessageState(stateRow?.state ?? '[]'); }
    catch (error) { throw new RuntimeError(ErrorCodes.WORLD_CORRUPT, storedError(error, 'message').details); }
    const views = { global: JSON.parse(worldRow.state), session: JSON.parse(session.state), message: structuredClone(messageState) };
    try {
      for (const scope of ['global', 'session', 'message'] as const) validateSnapshot(world.state, scope, views[scope]);
    } catch (error) { throw new RuntimeError(ErrorCodes.WORLD_CORRUPT, storedError(error, 'message').details); }
    const oldSummaryRow = [...chain].reverse().find(row => row.type === 'compaction' &&
      JSON.parse(row.ext_data).summary?.kind === 'sillyrealms.summary');
    const summaryExt = oldSummaryRow ? JSON.parse(oldSummaryRow.ext_data).summary : undefined;
    const summaryIndex = summaryExt ? chain.findIndex(row => row.id === summaryExt.coveredThroughEntryId) : -1;
    if (summaryExt && (summaryIndex < 0 || summaryIndex >= chain.indexOf(oldSummaryRow!) ||
        !this.store.narrative(chain[summaryIndex]!).length)) throw new RuntimeError(ErrorCodes.INVALID_SUMMARY_BOUNDARY);
    const runFlags = new Map<string, string>();
    for (const row of chain) {
      const run = JSON.parse(row.ext_data).run;
      if (!run || row.role !== 'user') continue;
      const state = run.extensions?.stateUpdate?.status;
      if (['stopped', 'failed', 'interrupted'].includes(run.status) || ['disabled', 'partial', 'failed', 'cancelled'].includes(state))
        runFlags.set(String(row.run_id), [run.status, state].filter(Boolean).join(':'));
    }
    const history = chain.slice(summaryIndex + 1).flatMap(row =>
      this.store.narrative(row).map(item => ({ ...item, ...(runFlags.has(String(row.run_id)) ? { gap: runFlags.get(String(row.run_id)) } : {}) })));
    const previousSummary = summaryExt ? {
      text: JSON.parse(oldSummaryRow!.payload).summary as string,
      coveredThroughEntryId: summaryExt.coveredThroughEntryId as string,
      gaps: Array.isArray(summaryExt.gaps) ? summaryExt.gaps.filter((v: unknown) => typeof v === 'string').slice(-32) : [],
    } : undefined;
    const gaps = [...new Set([...(previousSummary?.gaps ?? []), ...runFlags.values()])].slice(-32);
    const activationHistory = [...(previousSummary ? [{ role: 'assistant' as const, text: previousSummary.text }] : []), ...history];
    const context = buildContext(world, config.preset.nodes, String(session.user_character_id), views, activationHistory, input,
      { mode: config.execution.mode, capabilities: config.extensions, gaps });
    const active = new Set(context.activeModules.message);
    const tools = config.execution.mode === 'agent' && active.size ? [stateTool] : undefined;
    const execution: ExecutionContext = {
      identity: Object.freeze({ sessionId, worldId: String(session.world_id), runId, requestId, expectedTipEntryId: expectedTip }),
      input: Object.freeze({ text: input }),
      source: { history: structuredClone(history), summary: previousSummary, builder: context, gaps },
      state: { baseline: deepFreeze(structuredClone(messageState)), baselineHash: fingerprint(messageState),
        workspace: views.message, active, modules: world.state?.scopes?.message ?? {}, definition: world.state },
      progress: { phase: 'preparing', summaryCalls: 0, budgetReports: [], continuation: [],
        historyView: [...(previousSummary ? [{ id: 'summary', role: 'assistant' as const, text: previousSummary.text }] : []), ...history],
        summaryView: previousSummary },
      control: { signal }, accounting: args.runContext,
    };
    // The content, permissions and config above are fixed before this first await.
    await this.client.checkCredential(config.model.credentialRef, signal);
    const request = await this.prepareRequest(config, execution, 'generation',
      tools?.length ? requiredToolChoice(model) : undefined);
    const composition = estimateContextComposition(context, execution.progress.historyView, input);
    return { config, execution, model, messages: request.context.messages, tools: request.context.tools,
      toolChoice: request.toolChoice, modules: execution.state.modules, worldState: world.state,
      active, workspace: execution.state.workspace, userInput: input,
      output: config.generation.maxOutputTokens, temperature: config.generation.temperature, contextComposition: composition,
      summary: execution.progress.pendingSummary, summaryGeneration: [], diagnostics: context.diagnostics };
  }

  async prepareContinuation(prepared: PreparedRun, toolChoice?: ToolChoice): Promise<PreparedRequest> {
    return this.prepareRequest(prepared.config, prepared.execution, 'continuation', toolChoice);
  }

  private async measure(config: RuntimeConfig, execution: ExecutionContext, context: Context,
    purpose: BudgetReport['purpose'], output: number, toolChoice?: ToolChoice): Promise<PreparedRequest> {
    if (execution.control.signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
    const measurement = await this.client.measure(config.model.definition, context,
      { maxTokens: output, temperature: config.generation.temperature, toolChoice, signal: execution.control.signal });
    const report = evaluateBudget({ model: config.model.definition, context, output,
      temperature: config.generation.temperature, toolChoice, mode: config.execution.mode, purpose,
      policy: config.contextPolicy, measurement });
    requireMeasured(report);
    const request = { mode: config.execution.mode, purpose, model: config.model.definition,
      context: deepFreeze(context), output, temperature: config.generation.temperature, toolChoice,
      fingerprint: report.fingerprint, report };
    if (config.execution.mode === 'direct' && (context.tools?.length || toolChoice !== undefined))
      throw new RuntimeError(ErrorCodes.INVALID_TOOL_CALL);
    return deepFreeze(request) as PreparedRequest;
  }

  private async prepareRequest(config: RuntimeConfig, execution: ExecutionContext,
    purpose: 'generation' | 'continuation', toolChoice?: ToolChoice): Promise<PreparedRequest> {
    const { progress, source, state } = execution;
    const seen = new Set<string>();
    for (let pass = 0; ; pass++) {
      const messages = [...source.builder.messages(progress.historyView), ...progress.continuation];
      const tools = config.execution.mode === 'agent' && state.active.size ? [stateTool] : undefined;
      const request = await this.measure(config, execution, { messages, ...(tools ? { tools } : {}) },
        purpose, config.generation.maxOutputTokens, toolChoice);
      progress.budgetReports.push(request.report);
      if (progress.budgetReports.length > 32) progress.budgetReports.shift();
      if (request.report.fits) { execution.request = request; return request; }
      if (pass >= config.contextPolicy.overflow.maxPassesPerRequest || seen.has(request.fingerprint))
        throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
      seen.add(request.fingerprint);
      const before = request.report.tokens!;
      const compressed = await compressHistory({
        history: progress.historyView.filter(item => item.id !== 'summary'),
        oldSummary: progress.summaryView, shouldCompact: true,
        keepRecentTurns: config.contextPolicy.overflow.keepRecentTurns,
        summarize: summary => summarizeInBudget(summary, {
          prompt: source.builder.render(config.preset.summaryPrompt), gaps: source.gaps,
          signal: execution.control.signal,
          prepare: messages => this.measure(config, execution, { messages }, 'summary', config.contextPolicy.summary.maxOutputTokens),
          generate: async prepared => {
            if (progress.summaryCalls >= config.contextPolicy.overflow.maxSummaryCallsPerRun)
              throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
            progress.summaryCalls++;
            return this.client.events(config.model.definition, prepared.context, {
              credentialRef: config.model.credentialRef, signal: execution.control.signal,
              maxTokens: prepared.output, temperature: prepared.temperature, prepared,
            }, execution.accounting.request('summary'));
          },
        }),
      });
      if (!compressed.summary) throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
      const candidate = { text: compressed.summary.text, coveredThroughEntryId: compressed.summary.coveredThroughEntryId, gaps: source.gaps };
      const nextContext: Context = { messages: [...source.builder.messages(compressed.history), ...progress.continuation], ...(tools ? { tools } : {}) };
      const next = await this.measure(config, execution, nextContext, purpose, config.generation.maxOutputTokens, toolChoice);
      if (next.report.tokens! >= before) throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
      progress.historyView = compressed.history;
      progress.summaryView = candidate;
      if (next.report.fits) progress.pendingSummary = candidate;
    }
  }
}
