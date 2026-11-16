import type { Context } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../common/error-codes.js';
import {captureSources} from './snapshot.js';
import { compileContext } from './node-compiler.js';
import { prepareForRun } from './compaction/index.js';
import { generateSummary } from './compaction/summary-generator.js';
import type { HistoryItem } from './compaction/history.js';
import { inputIdentity, type InputBaseline } from './compaction/estimator.js';
import { RuntimeError } from '../shared/errors.js';
import type { PreparedRun, RuntimeConfig, ExecutionContext } from '../types.js';
import type { RunStore } from '../persistence/run-store.js';
import type { ModelClient } from '../model/model-client.js';
import type { RunAccounting } from '../persistence/usage-store.js';
import { deepFreeze, fingerprint } from '../config.js';
import { requestFingerprint, summaryInputLimit, type PreparedRequest } from './budget.js';
export { summaryNarrative } from './compaction/history.js';

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
    if (!this.client.supportsDirect(model)) throw new RuntimeError(ErrorCodes.NARRATIVE_SYSTEM_ORDER_UNSUPPORTED);
    const {snapshot,history,oldSummary,messageState,world}=captureSources(this.store,sessionId,expectedTip,input);
    const compile=(items:HistoryItem[])=>compileContext({...snapshot,nodes:config.preset.nodes,history:items,presetHash:config.preset.hash});
    const preview=(items:HistoryItem[]):Context=>({messages:compile(items).messages});
    const identity=(context:Context)=>inputIdentity(model,context,{strategy:config.contextPolicy.budget.strategy,
      reasoning:config.generation.thinkingEnabled&&model.reasoning?'medium':undefined});
    const baseline = JSON.parse(String(session.usage_json)).latestContext?.baseline as InputBaseline | undefined;
    // Every source above is captured before the first credential/model await.
    await this.client.checkCredential(config.model.credentialRef, signal);
    let summaryCalls = 0;
    const result = await prepareForRun({ history, oldSummary, policy: config.contextPolicy, preview, identity, baseline,
      summarize: (previous, items) => generateSummary({ previous, history: items, prompt: config.contextPolicy.summary.prompt, limit: summaryInputLimit(model, config.contextPolicy), signal,
        generate: async messages => {
          if (summaryCalls++) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
          const request = await this.request(config, { messages }, 'summary', config.contextPolicy.summary.maxOutputTokens, signal);
          return this.client.events(model, request.context, { credentialRef: config.model.credentialRef, signal,
            maxTokens: request.output, temperature: request.temperature, reasoning: request.reasoning, prepared: request }, args.runContext.request('summary'));
        } }),
    });
    if (signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
    const context=compile(result.history),active=new Set(context.activeRoots);
    const request=await this.request(config,{messages:context.messages},'generation',config.generation.maxOutputTokens,signal);
    const execution: ExecutionContext = {
      identity: Object.freeze({ sessionId, worldId: String(session.world_id), runId, requestId, expectedTipEntryId: expectedTip }),
      input: Object.freeze({ text: input }), source: { history, summary: oldSummary, snapshot },
      state: { baseline: deepFreeze(structuredClone(messageState)), baselineHash: fingerprint(messageState),
        active, modules: world.state?.scopes?.message ?? {}, definition: world.state },
      progress: { phase: 'preparing' },
      control: { signal }, accounting: args.runContext, request,
    };
    return { config, execution, model, compiled:context,postprocess:context.postprocess,
      worldState: world.state, active,
      contextComposition: context.composition, summary: result.summary };

  }
  private async request(config: RuntimeConfig, context: Context, purpose: PreparedRequest['purpose'], output: number,
    signal: AbortSignal): Promise<PreparedRequest> {
    if (signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
    const model = config.model.definition;
    const reasoning = config.generation.thinkingEnabled && model.reasoning ? 'medium' as const : undefined;
    const options = { maxTokens: output, temperature: config.generation.temperature, reasoning };
    const request = { purpose, model, context: deepFreeze(context), output,
      temperature: options.temperature, reasoning: options.reasoning, strategy: config.contextPolicy.budget.strategy,
      fingerprint: requestFingerprint(model, context, options), wireFingerprint: await this.client.preview(model, context, { ...options, signal }) };
    if (context.tools?.length) throw new RuntimeError(ErrorCodes.INVALID_TOOL_CALL);
    return deepFreeze(request) as PreparedRequest;
  }
}
