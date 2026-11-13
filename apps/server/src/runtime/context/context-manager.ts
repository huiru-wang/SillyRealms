import type { Context, ToolChoice } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../common/error-codes.js';
import { decodeMessageState, validateSnapshot, type Json } from '../../domain/state/state.js';
import { storedError } from '../../domain/world-card.js';
import { readWorld } from '../../repositories/world-repository.js';
import { buildContext, estimateNarrativeItemSize, estimateMessageBytes } from './prompt-builder.js';
import { prepareForRun } from './compaction/index.js';
import { generateSummary } from './compaction/summary-generator.js';
import type { HistoryItem } from './compaction/history.js';
import { inputIdentity, type InputBaseline } from './compaction/estimator.js';
import { stateTool } from '../tools/state-tool.js';
import { RuntimeError } from '../shared/errors.js';
import type { PreparedRun, RuntimeConfig, ExecutionContext, SummaryCandidate } from '../types.js';
import type { RunStore } from '../persistence/run-store.js';
import type { ModelClient } from '../model/model-client.js';
import type { ContextComposition, RunAccounting } from '../persistence/usage-store.js';
import { deepFreeze, fingerprint } from '../config.js';
import { requestFingerprint, summaryInputLimit, type PreparedRequest } from './budget.js';
import { requiredToolChoice } from '../model/pi-gateway.js';
export { summaryNarrative } from './compaction/history.js';

export function estimateContextComposition(context: ReturnType<typeof buildContext>, history: HistoryItem[], input: string): ContextComposition {
  const systemMessages = context.trace([]).filter(row => row.nodeId !== 'chatHistory' && row.nodeId !== 'userInput').flatMap(row => row.messages);
  const summary = history.find(item => item.id === 'summary');
  return { systemBytes: estimateMessageBytes(systemMessages), summaryBytes: summary ? estimateNarrativeItemSize(summary) : 0,
    historyBytes: history.filter(item => item.id !== 'summary').reduce((sum, item) => sum + estimateNarrativeItemSize(item), 0) + estimateNarrativeItemSize({ role: 'user', text: input }) };
}

export class ContextManager {
  constructor(private store: RunStore, private client: ModelClient) {}
  async prepare(args: { sessionId: string; input: string; runId: string; requestId: string; expectedTip: string;
    signal: AbortSignal; runContext: RunAccounting; config: RuntimeConfig }): Promise<PreparedRun> {
    const { sessionId, input, runId, requestId, expectedTip, signal, config } = args;
    const session = this.store.session(sessionId);
    if (!session) throw new RuntimeError(ErrorCodes.SESSION_NOT_FOUND);
    const duplicate = this.store.duplicate(sessionId, requestId);
    if (duplicate && duplicate !== runId) throw new RuntimeError(ErrorCodes.REQUEST_ALREADY_EXISTS);
    if (session.tip_entry_id !== expectedTip) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
    const model = config.model.definition;
    if (config.execution.mode === 'direct' && !this.client.supportsDirect(model)) throw new RuntimeError(ErrorCodes.NARRATIVE_SYSTEM_ORDER_UNSUPPORTED);
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
    try { for (const scope of ['global', 'session', 'message'] as const) validateSnapshot(world.state, scope, views[scope]); }
    catch (error) { throw new RuntimeError(ErrorCodes.WORLD_CORRUPT, storedError(error, 'message').details); }
    const flags = new Map<string, string>();
    for (const row of chain) {
      const run = JSON.parse(row.ext_data).run, state = run?.extensions?.stateUpdate?.status;
      if (run && row.role === 'user' && (['stopped', 'failed', 'interrupted'].includes(run.status) || ['disabled', 'partial', 'failed', 'cancelled'].includes(state)))
        flags.set(String(row.run_id), [run.status, state].filter(Boolean).join(':'));
    }
    const history = chain.flatMap(row => this.store.narrative(row).map(item => ({ ...item,
      ...(flags.has(String(row.run_id)) ? { gap: flags.get(String(row.run_id)) } : {}) })));
    const oldRow = [...chain].reverse().find(row => row.type === 'compaction' && JSON.parse(row.ext_data).summary?.kind === 'sillyrealms.summary');
    const oldExt = oldRow ? JSON.parse(oldRow.ext_data).summary : undefined;
    const boundary = oldExt ? chain.findIndex(row => row.id === oldExt.coveredThroughEntryId) : -1;
    const oldText = oldRow ? JSON.parse(oldRow.payload).summary : undefined;
    const historyBoundary = oldExt ? history.findIndex(item => item.id === oldExt.coveredThroughEntryId) : -1;
    // Invalid summary metadata can be ignored because the complete valid source chain is available.
    const oldSummary: SummaryCandidate | undefined = oldExt && boundary >= 0 && boundary < chain.indexOf(oldRow!) &&
      historyBoundary >= 0 && (!history[historyBoundary + 1] || history[historyBoundary + 1]!.role === 'user') &&
      typeof oldText === 'string' && oldText.trim()
      ? { text: oldText, coveredThroughEntryId: oldExt.coveredThroughEntryId,
        gaps: Array.isArray(oldExt.gaps) ? oldExt.gaps.filter((v: unknown) => typeof v === 'string').slice(-32) : [] } : undefined;
    const gaps = [...new Set([...(oldSummary?.gaps ?? []), ...flags.values()])].slice(-32);
    const playerId = String(session.user_character_id);
    deepFreeze(world); deepFreeze(views); deepFreeze(history);
    const builder = (items: HistoryItem[]) => buildContext(world, config.preset.nodes, playerId, views, items, input,
      { mode: config.execution.mode, capabilities: config.extensions, gaps, preview: true });
    const preview = (items: HistoryItem[]): Context => {
      const built = builder(items);
      return { messages: built.messages(items), ...(config.execution.mode === 'agent' && built.activeModules.message.size ? { tools: [stateTool] } : {}) };
    };
    const choice = (context: Context) => context.tools?.length ? requiredToolChoice(model) : undefined;
    const identity = (context: Context) => inputIdentity(model, context, { mode: config.execution.mode,
      strategy: config.contextPolicy.budget.strategy, toolChoice: choice(context) });
    const baseline = JSON.parse(String(session.usage_json)).latestContext?.baseline as InputBaseline | undefined;
    // Every source above is captured before the first credential/model await.
    await this.client.checkCredential(config.model.credentialRef, signal);
    let summaryCalls = 0;
    const result = await prepareForRun({ history, oldSummary, policy: config.contextPolicy, preview, identity, baseline,
      summarize: (previous, items) => generateSummary({ previous, history: items, prompt: builder([]).render(config.preset.summaryPrompt),
        gaps, limit: summaryInputLimit(model, config.contextPolicy), signal,
        generate: async messages => {
          if (summaryCalls++) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
          const request = await this.request(config, { messages }, 'summary', config.contextPolicy.summary.maxOutputTokens, signal);
          return this.client.events(model, request.context, { credentialRef: config.model.credentialRef, signal,
            maxTokens: request.output, temperature: request.temperature, prepared: request }, args.runContext.request('summary'));
        } }),
    });
    if (signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
    const context = builder(result.history), active = new Set(context.activeModules.message);
    const final: Context = { messages: context.messages(result.history), ...(config.execution.mode === 'agent' && active.size ? { tools: [stateTool] } : {}) };
    const request = await this.request(config, final, 'generation', config.generation.maxOutputTokens, signal, choice(final));
    const execution: ExecutionContext = {
      identity: Object.freeze({ sessionId, worldId: String(session.world_id), runId, requestId, expectedTipEntryId: expectedTip }),
      input: Object.freeze({ text: input }), source: { history, summary: oldSummary, builder: context, gaps },
      state: { baseline: deepFreeze(structuredClone(messageState)), baselineHash: fingerprint(messageState), workspace: structuredClone(messageState),
        active, modules: world.state?.scopes?.message ?? {}, definition: world.state },
      progress: { phase: 'preparing', summaryCalls, preparationReport: result.report, continuation: [], historyView: result.history, summaryView: result.summary ?? oldSummary },
      control: { signal }, accounting: args.runContext, request,
    };
    return { config, execution, model, messages: request.context.messages, tools: request.context.tools, toolChoice: request.toolChoice,
      modules: execution.state.modules, worldState: world.state, active, workspace: execution.state.workspace, userInput: input,
      output: config.generation.maxOutputTokens, temperature: config.generation.temperature,
      contextComposition: estimateContextComposition(context, result.history, input), summary: result.summary, summaryGeneration: [], diagnostics: context.diagnostics };
  }
  async buildContinuationRequest(prepared: PreparedRun, toolChoice?: ToolChoice): Promise<PreparedRequest> {
    const { execution, config } = prepared;
    const context: Context = { messages: [...execution.source.builder.messages(execution.progress.historyView), ...execution.progress.continuation],
      ...(execution.state.active.size ? { tools: [stateTool] } : {}) };
    return this.request(config, context, 'continuation', config.generation.maxOutputTokens, execution.control.signal, toolChoice);
  }
  private async request(config: RuntimeConfig, context: Context, purpose: PreparedRequest['purpose'], output: number,
    signal: AbortSignal, toolChoice?: ToolChoice): Promise<PreparedRequest> {
    if (signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
    const model = config.model.definition, options = { maxTokens: output, temperature: config.generation.temperature, toolChoice };
    const request = { mode: config.execution.mode, purpose, model, context: deepFreeze(context), output,
      temperature: options.temperature, toolChoice, strategy: config.contextPolicy.budget.strategy,
      fingerprint: requestFingerprint(model, context, options), wireFingerprint: await this.client.preview(model, context, { ...options, signal }) };
    if (config.execution.mode === 'direct' && (context.tools?.length || toolChoice !== undefined)) throw new RuntimeError(ErrorCodes.INVALID_TOOL_CALL);
    return deepFreeze(request) as PreparedRequest;
  }
}
