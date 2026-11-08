import { isDeepStrictEqual } from 'node:util';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../common/error-codes.js';
import { debugLog } from '../../common/debug.js';
import { validateSnapshot, type Json } from '../../domain/state/state.js';
import { RuntimeError } from '../shared/errors.js';
import type { ModelClient } from '../model/model-client.js';
import type { UsageStore, RunContext } from '../persistence/usage-store.js';
import type { RunPostProcessor } from './run-post-processor.js';
import type { RunStore, RunOutcome } from '../persistence/run-store.js';
import type { RunEvent, RunTask, PreparedRun } from './types.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import { stateReviewMessages, stateReviewTool } from '../tools/state-tool.js';
import { requiredToolChoice } from '../model/pi-gateway.js';

export class AgentRunner {
  constructor(
    private store: RunStore,
    private client: ModelClient,
    private executor: ToolExecutor,
    private emit: RunEvent,
    private usage: UsageStore,
    private postProcessor: RunPostProcessor,
  ) {}

  /** One execution per user turn. Persists streaming output before publishing deltas. */
  async execute(args: {
    sessionId: string; runId: string; userId: string;
    prepared: PreparedRun; task: RunTask; runContext: RunContext;
    streamController: ReadableStreamDefaultController<Uint8Array>;
    release: () => void;
  }): Promise<void> {
    const { sessionId, runId, userId, prepared, task, runContext, streamController, release } = args;
    const { model, key, messages, tools, modules, worldState, active, workspace, output, temperature, userInput } = prepared;
    let outcome: RunOutcome = 'completed';
    const initialWorkspace = JSON.stringify(workspace);
    let partialId: string | null = null, partialText = '', pendingHigh = '';
    let hadSuccessfulStateCall = false;
    const narrative: string[] = [];

    const writeText = async (text: string) => {
      if (!text || task.stopped) return;
      const offset = partialText.length;
      partialText += text;
      if (!partialId) {
        partialId = this.store.createPartial(sessionId, runId, partialText);
        this.emit(sessionId, 'message.created', {
          runId, message: { id: partialId, role: 'assistant', text: '', status: 'streaming', createdAt: Date.now() },
        });
      } else {
        this.store.updatePartial(partialId, partialText);
      }
      this.emit(sessionId, 'message.delta', { runId, messageId: partialId, offset, text });
      try { runContext.firstVisible(this.usage); }
      catch (error) { debugLog('首段叙事统计写入失败', { sessionId, runId, error: String(error) }); }
      streamController.enqueue(new TextEncoder().encode(text));
      if (streamController.desiredSize !== null && streamController.desiredSize <= 0 && !task.stopped) {
        await new Promise<void>(resolve => {
          const wake = () => {
            task.drain = undefined;
            task.controller.signal.removeEventListener('abort', wake);
            resolve();
          };
          task.drain = wake;
          task.controller.signal.addEventListener('abort', wake, { once: true });
          if (task.controller.signal.aborted) wake();
        });
      }
    };

    try {
      for (let turn = 0; turn < 32; turn++) {
        partialId = null;
        partialText = '';
        pendingHigh = '';
        let final: AssistantMessage | undefined;
        const request = runContext.request(turn === 0 ? 'generation' : 'continuation');
        for await (const event of this.client.events(model, { messages, tools }, {
          apiKey: key, signal: task.controller.signal, maxTokens: output, temperature,
        }, request)) {
          if (task.stopped) break;
          if (event.type === 'text_delta' && event.delta) {
            let chunk = pendingHigh + event.delta;
            pendingHigh = '';
            const last = chunk.charCodeAt(chunk.length - 1);
            if (last >= 0xd800 && last <= 0xdbff) {
              pendingHigh = chunk.slice(-1);
              chunk = chunk.slice(0, -1);
            }
            // Match the UTF-8 replacement behavior of the stream encoder.
            await writeText(new TextDecoder().decode(new TextEncoder().encode(chunk)));
          } else if (event.type === 'done') {
            if (pendingHigh) { await writeText('\uFFFD'); pendingHigh = ''; }
            final = event.message;
          } else if (event.type === 'error' && !task.stopped) {
            throw new RuntimeError(ErrorCodes.PROVIDER_ERROR);
          }
        }
        if (task.stopped) { outcome = 'stopped'; break; }
        if (!final) throw new RuntimeError(ErrorCodes.PROVIDER_ERROR);

        const finalText = final.content.filter(p => p.type === 'text').map(p => p.text).join('');
        if (finalText) narrative.push(finalText);
        const savedId = this.store.completeAssistant(sessionId, runId, final, finalText, partialId, partialText);
        try { this.usage.attachEntry(sessionId, runId, request.requestId, savedId); }
        catch (error) { debugLog('Assistant 统计关联失败', { sessionId, runId, error: String(error) }); }
        if (!partialId && finalText) {
          this.emit(sessionId, 'message.created', {
            runId, message: { id: savedId, role: 'assistant', text: finalText, status: 'completed', createdAt: final.timestamp },
          });
        }
        if (partialId) this.emit(sessionId, 'message.final', { runId, messageId: partialId, status: 'completed' });
        messages.push(final);
        const calls = final.content.filter(p => p.type === 'toolCall');
        if (!calls.length) break;
        for (const call of calls) {
          if (task.stopped) break;
          const result = this.executor.execute(call, workspace, modules, active);
          if (!result.isError && call.name === 'update_state') hadSuccessfulStateCall = true;
          this.store.appendToolResult(sessionId, runId, result);
          messages.push(result);
        }
        if (task.stopped) { outcome = 'stopped'; break; }
        if (turn === 31) throw new RuntimeError(ErrorCodes.TOOL_LIMIT_EXCEEDED);
      }

      // A model that ended prose without calling the optional tool gets one
      // mandatory, compact state check. No active message state: no extra call.
      if (!task.stopped && active.size > 0 && !hadSuccessfulStateCall) {
        const toolChoice = requiredToolChoice(model);
        if (!toolChoice) throw new RuntimeError(ErrorCodes.PROVIDER_ERROR);
        const reviewMessages = stateReviewMessages(modules, active, workspace, userInput, narrative.join('\n\n'));
        let review: AssistantMessage | undefined;
        const reviewRequest = runContext.request('state_review');
        for await (const event of this.client.events(model, { messages: reviewMessages, tools: [stateReviewTool] }, {
          apiKey: key, signal: task.controller.signal, maxTokens: output, temperature, toolChoice,
        }, reviewRequest)) {
          if (task.stopped) break;
          if (event.type === 'done') review = event.message;
          else if (event.type === 'error') throw new RuntimeError(ErrorCodes.PROVIDER_ERROR);
        }
        if (!task.stopped) {
          const calls = review?.content.filter(p => p.type === 'toolCall') ?? [];
          if (calls.length !== 1 || calls[0]!.name !== 'review_state') {
            throw new RuntimeError(ErrorCodes.PROVIDER_ERROR);
          }
          const result = this.executor.executeReview(calls[0]!, workspace, modules, active);
          // Preserve the tool protocol but never show unsolicited review prose.
          const reviewId = this.store.completeAssistant(sessionId, runId, { ...review!, content: calls }, '', null, '');
          try { this.usage.attachEntry(sessionId, runId, reviewRequest.requestId, reviewId); }
          catch (error) { debugLog('状态检查统计关联失败', { sessionId, runId, error: String(error) }); }
          this.store.appendToolResult(sessionId, runId, result);
          if (result.isError) throw new RuntimeError(ErrorCodes.INVALID_STATE_UPDATE);
        }
      }
      if (task.stopped) outcome = 'stopped';
    } catch (error) {
      debugLog('模型执行异常', {
        sessionId, runId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      });
      outcome = task.stopped ? 'stopped' : 'failed';
    }

    try {
      if (outcome !== 'failed') validateSnapshot(worldState, 'message', workspace);
      this.store.finalize(sessionId, userId, partialId, outcome, workspace);
    } catch {
      outcome = 'failed';
      this.store.markCommitFailed(userId);
    }
    if (partialId && outcome !== 'completed') this.emit(sessionId, 'message.final', { runId, messageId: partialId, status: outcome });
    if (outcome !== 'failed') {
      const previous = JSON.parse(initialWorkspace) as Record<string, Json>;
      for (const [path, value] of Object.entries(workspace)) {
        if (!isDeepStrictEqual(previous[path], value)) this.emit(sessionId, 'state.changed', { path, scope: 'message', value });
      }
    }
    // Metrics settlement is independent from narrative/state commits and must run once
    // before the terminal event is emitted. A metrics error must not lock the session.
    try { this.postProcessor.process(runContext, outcome); }
    catch (error) { debugLog('Run 统计后置处理失败', { sessionId, runId, error: String(error) }); }
    try {
      this.emit(sessionId, 'run.updated', {
        runId, status: outcome, tipEntryId: this.store.tip(sessionId),
        ...(outcome === 'failed' ? { errorCode: 'RUN_FAILED' } : {}),
      });
      try { streamController.close(); } catch { /* consumer already disconnected */ }
    } finally { release(); }
  }
}
