import type { Api, Message, Model } from '@earendil-works/pi-ai';
import { parseRoleplay } from '@sillyrealms/roleplay';
import { ErrorCodes } from '../../common/error-codes.js';
import { debugEnabled, debugLog } from '../../common/debug.js';
import type { CredentialStore } from '../../infrastructure/credentials/store.js';
import { decodeMessageState, validateSnapshot, type Json } from '../../domain/state/state.js';
import { storedError } from '../../domain/world-card.js';
import { readWorld } from '../../repositories/world-repository.js';
import { buildContext, estimateNarrativeItemSize, estimateMessageBytes } from './prompt-builder.js';
import { SR_RP_SUMMARY_GUIDANCE } from './system-main.js';
import { compressHistory, type HistoryItem } from './history-compactor.js';
import { stateTool } from '../tools/state-tool.js';
import { RuntimeError } from '../shared/errors.js';
import type { PreparedRun } from '../runtime/types.js';
import type { RunStore } from '../persistence/run-store.js';
import type { ModelClient } from '../model/model-client.js';
import type { ContextComposition, RunContext, SessionUsage } from '../persistence/usage-store.js';

type SummaryRequest = Parameters<Parameters<typeof compressHistory>[0]['summarize']>[0];
const CONTEXT_STRATEGIES = { compact:131_072, standard:262_144, extended:524_288 } as const;
export function contextTriggerThreshold(strategy: keyof typeof CONTEXT_STRATEGIES, modelWindow: number, output: number): number {
  return Math.min(CONTEXT_STRATEGIES[strategy], modelWindow) - output - 1024 - 2048;
}

/** Structural byte-size illustration of system, summary, and retained history. */
export function estimateContextComposition(
  context: ReturnType<typeof buildContext>, history: HistoryItem[], input: string,
): ContextComposition {
  const systemMessages = context.trace([]).filter(row => row.nodeId !== 'chatHistory' && row.nodeId !== 'userInput')
    .flatMap(row => row.messages);
  const summary = history.find(item => item.id === 'summary');
  return {
    systemBytes: estimateMessageBytes(systemMessages),
    summaryBytes: summary ? estimateNarrativeItemSize(summary) : 0,
    historyBytes: history.filter(item => item.id !== 'summary')
      .reduce((total, item) => total + estimateNarrativeItemSize(item), 0)
      + estimateNarrativeItemSize({ role:'user', text:input }),
  };
}

/** Remove player direction before chunking, preserving code-point offsets for trace boundaries. */
export function summaryNarrative(text: string, role: 'user' | 'assistant'): string {
  const ranges = parseRoleplay(text, role).ranges.filter(range => range.kind === 'instruction');
  return ranges.reduceRight((value, range) => value.slice(0, range.start) +
    value.slice(range.start, range.end).replace(/[^\r\n]/gu, ' ') + value.slice(range.end), text);
}


/** Reads the current worldline and builds an invocation-ready context; does not write run state. */
export class ContextManager {
  constructor(private store: RunStore, private credentials: CredentialStore, private modelClient: ModelClient) {}

  async prepare(args: {
    sessionId: string; input: string; runId: string; requestId: string; expectedTip: string; signal: AbortSignal; runContext?: RunContext;
  }): Promise<PreparedRun> {
    const { sessionId, input, runId, requestId, expectedTip, signal } = args;
    const session = this.store.session(sessionId);
    if (!session) throw new RuntimeError(ErrorCodes.SESSION_NOT_FOUND);
    const duplicate = this.store.duplicate(sessionId, requestId);
    if (duplicate) throw new RuntimeError(ErrorCodes.REQUEST_ALREADY_EXISTS, { runId: duplicate });
    if (session.tip_entry_id !== expectedTip) throw new RuntimeError(ErrorCodes.TIP_CONFLICT);
    if (!session.preset_id) throw new RuntimeError(ErrorCodes.PRESET_NOT_SELECTED);
    const presetRow = this.store.preset(session.preset_id);
    if (!presetRow) throw new RuntimeError(ErrorCodes.PRESET_NOT_FOUND);
    const preset = JSON.parse(String(presetRow.config_json));
    if (!session.api_model_config_id) throw new RuntimeError(ErrorCodes.API_MODEL_CONFIG_NOT_SELECTED);
    const temperature = preset.model_parameters?.temperature;
    if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
      throw new RuntimeError(ErrorCodes.INVALID_MODEL_PARAMETERS);
    }
    const strategy = preset.budget?.context_strategy;
    if (!Number.isInteger(preset.budget?.max_output_tokens) || preset.budget.max_output_tokens <= 0 ||
      !Object.hasOwn(CONTEXT_STRATEGIES, strategy)) {
      throw new RuntimeError(ErrorCodes.INVALID_PRESET_BUDGET);
    }
    const config = this.store.modelConfig(session.api_model_config_id);
    if (!config) throw new RuntimeError(ErrorCodes.API_MODEL_CONFIG_NOT_FOUND);
    const key = await this.credentials.get(config.credential_ref);
    if (!key) throw new RuntimeError(ErrorCodes.CREDENTIAL_NOT_CONFIGURED);
    const model = this.modelClient.resolve(config.provider_id, config.model_id);
    if (!model) throw new RuntimeError(ErrorCodes.MODEL_NOT_FOUND);
    const worldRow = this.store.world(session.world_id);
    if (!worldRow) throw new RuntimeError(ErrorCodes.WORLD_NOT_FOUND);
    let world: ReturnType<typeof readWorld>['data'];
    try { world = readWorld(worldRow).data; }
    catch (error) { throw new RuntimeError(ErrorCodes.WORLD_CORRUPT, storedError(error).details); }

    const chain = this.store.ancestors(sessionId, session.tip_entry_id);
    const stateRow = [...chain].reverse().find(row => row.state !== null);
    let messageState: Record<string, Json>;
    try { messageState = decodeMessageState(stateRow?.state ?? '[]'); }
    catch (error) { throw new RuntimeError(ErrorCodes.WORLD_CORRUPT, storedError(error, 'message').details); }
    const views = { global: JSON.parse(worldRow.state), session: JSON.parse(session.state), message: structuredClone(messageState) };
    try {
      for (const scope of ['global', 'session', 'message'] as const) validateSnapshot(world.state, scope, views[scope]);
    } catch (error) {
      throw new RuntimeError(ErrorCodes.WORLD_CORRUPT, storedError(error, 'message').details);
    }

    const oldSummaryRow = [...chain].reverse().find(row => row.type === 'compaction' &&
      JSON.parse(row.ext_data).summary?.kind === 'sillyrealms.summary');
    const summaryExt = oldSummaryRow ? JSON.parse(oldSummaryRow.ext_data).summary : undefined;
    const summaryIndex = summaryExt ? chain.findIndex(row => row.id === summaryExt.coveredThroughEntryId) : -1;
    if (summaryExt && (summaryIndex < 0 || summaryIndex >= chain.indexOf(oldSummaryRow!) ||
      this.store.narrative(chain[summaryIndex]!).length === 0)) throw new RuntimeError(ErrorCodes.INVALID_SUMMARY_BOUNDARY);
    const history = chain.slice(summaryIndex + 1).flatMap(row => this.store.narrative(row));
    const previousSummary = summaryExt ? {
      text: JSON.parse(oldSummaryRow!.payload).summary as string,
      coveredThroughEntryId: summaryExt.coveredThroughEntryId as string,
    } : undefined;
    const candidateHistory = [...(previousSummary ? [{ role: 'assistant' as const, text: previousSummary.text }] : []), ...history];
    const context = buildContext(world, preset.nodes, session.user_character_id, views, candidateHistory, input);
    for (const diagnostic of context.diagnostics) console.warn('SR_LOAD_UNMATCHED', { runId, ...diagnostic });

    const modules = world.state?.scopes?.message ?? {};
    const tools = context.activeModules.message.size > 0 ? [stateTool] : [];
    const buildMessages = (records: HistoryItem[]): Message[] => context.messages(records);
    const output = preset.budget.max_output_tokens;
    const budget = contextTriggerThreshold(strategy as keyof typeof CONTEXT_STRATEGIES, model.contextWindow, output);
    if (!Number.isFinite(budget) || budget <= 0 || output > model.maxTokens) {
      throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
    }

    const snapshot = (JSON.parse(String(session.usage_json)) as SessionUsage).latestContext;
    const validSnapshot = snapshot && snapshot.outputTokens !== undefined &&
      snapshot.apiModelConfigId === session.api_model_config_id && snapshot.modelId === model.id;
    const shouldCompact = !validSnapshot || snapshot.inputTokens + snapshot.outputTokens! >= budget;

    const summaryGeneration: Array<{ request: unknown; response: string }> = [];
    const compressed = await compressHistory({
      history, oldSummary: previousSummary, shouldCompact,
      summarize: async request => {
        const result = await this.summarize(request, {
          model, key, signal, output, temperature, runContext: args.runContext,
          renderPrompt: () => context.render(preset.summary_prompt),
        });
        summaryGeneration.push(...result.generations);
        return result.text;
      },
    });
    if (signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
    const messages = buildMessages(compressed.history);
    // The provider reports only one aggregate input count. This separate composition
    // is intentionally a byte-size illustration of the three visible prompt sections,
    // not a tokenizer-derived or billable Token breakdown.
    const contextComposition = estimateContextComposition(context, compressed.history, input);
    if (debugEnabled()) {
      const rows = context.trace(compressed.history);
      console.log(`\n┌─ 预设节点顺序 ─ run=${JSON.stringify(runId)} ─`);
      for (const row of rows) console.log(`│ ${String(row.index + 1).padStart(2, '0')} | ${JSON.stringify(row.name)} | id=${JSON.stringify(row.nodeId)} | ${row.enabled ? '启用' : '关闭'} | role=${row.role} | ${row.messages.length ? `有内容（${row.messages.length} 条）` : '无内容'}`);
      console.log('└─ 预设节点顺序 ─');
      debugLog('发送给 Agent 的完整 messages', messages);
    }
    return {
      model, key, messages, tools, modules, worldState: world.state,
      active: context.activeModules.message, workspace: views.message, userInput: input,
      output, temperature, contextComposition, summary: compressed.summary, summaryGeneration,
      diagnostics: context.diagnostics,
    };
  }

  /** Split oversized compaction inputs without losing character ranges or history boundaries. */
  private async summarize(request: SummaryRequest, config: {
    model: Model<Api>; key: string; signal: AbortSignal; output: number; temperature?: number;
    renderPrompt: () => string; runContext?: RunContext;
  }): Promise<{ text: string; generations: Array<{ request: unknown; response: string }> }> {
    let previous = request.previous;
    const source = request.chunks.map(item => ({ item, chars: Array.from(summaryNarrative(item.text, item.role)), offset: 0 }));
    let index = 0;
    const generations: Array<{ request: unknown; response: string }> = [];
    while (index < source.length) {
      const batch: Array<{ sourceEntryId: string; start: number; end: number; role: string; text: string }> = [];
      const makeMessages = (pieces: typeof batch): Message[] => [
        { role: 'system', content: [SR_RP_SUMMARY_GUIDANCE, config.renderPrompt()].filter(Boolean).join('\n\n'), timestamp: Date.now() },
        { role: 'user', content: JSON.stringify({ previous, messages: pieces.map(p => ({ role: p.role, text: p.text })) }), timestamp: Date.now() },
      ];
      while (index < source.length) {
        const part = source[index]!;
        let low = part.offset + 1, high = part.chars.length, fit = part.offset;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          const candidate = { sourceEntryId: part.item.id, start: part.offset, end: mid, role: part.item.role, text: part.chars.slice(part.offset, mid).join('') };
          // Character limit only bounds summary batches; it is not a Token estimate.
          if (Array.from(JSON.stringify([...batch, candidate])).length <= 12_000) { fit = mid; low = mid + 1; }
          else high = mid - 1;
        }
        if (fit === part.offset) break;
        batch.push({ sourceEntryId: part.item.id, start: part.offset, end: fit, role: part.item.role, text: part.chars.slice(part.offset, fit).join('') });
        part.offset = fit;
        if (part.offset === part.chars.length) index++;
        else break;
      }
      if (!batch.length) throw new RuntimeError(ErrorCodes.CONTEXT_BUDGET_EXCEEDED);
      const messages = makeMessages(batch);
      let text = '', ended = false;
      for await (const event of this.modelClient.events(config.model, { messages }, {
        apiKey: config.key, signal: config.signal, maxTokens: config.output, temperature: config.temperature,
      }, config.runContext?.request('summary'))) {
        if (event.type === 'text_delta') text += event.delta;
        if (event.type === 'done') ended = true;
        if (event.type === 'error') throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
      }
      if (!ended || !text.trim()) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
      generations.push({ request: { previous, chunks: batch }, response: text });
      previous = text;
    }
    if (!previous) throw new RuntimeError(ErrorCodes.SUMMARY_FAILED);
    return { text: previous, generations };
  }
}
