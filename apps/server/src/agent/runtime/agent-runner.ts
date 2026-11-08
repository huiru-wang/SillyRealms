import { isDeepStrictEqual } from 'node:util';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../common/error-codes.js';
import { debugLog } from '../../common/debug.js';
import { validateSnapshot, type Json } from '../../domain/state/state.js';
import { RuntimeError } from '../shared/errors.js';
import type { ModelClient } from '../model/model-client.js';
import type { RunStore, RunOutcome } from '../persistence/run-store.js';
import type { RunEvent, RunTask, PreparedRun } from './types.js';
import type { ToolExecutor } from '../tools/tool-executor.js';

export class AgentRunner {
  constructor(
    private store: RunStore,
    private client: ModelClient,
    private executor: ToolExecutor,
    private emit: RunEvent,
  ) {}

  /** One execution per user turn. Persists streaming output before publishing deltas. */
  async execute(args: {
    sessionId: string; runId: string; userId: string;
    prepared: PreparedRun; task: RunTask;
    streamController: ReadableStreamDefaultController<Uint8Array>;
    release: () => void;
  }): Promise<void> {
    const { sessionId, runId, userId, prepared, task, streamController, release } = args;
    const { model, key, messages, tools, modules, worldState, active, workspace, output, temperature } = prepared;
    let outcome: RunOutcome = 'completed';
    const initialWorkspace = JSON.stringify(workspace);
    let partialId: string | null = null, partialText = '', pendingHigh = '';

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
        for await (const event of this.client.events(model, { messages, tools }, {
          apiKey: key, signal: task.controller.signal, maxTokens: output, temperature,
        })) {
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
        const savedId = this.store.completeAssistant(sessionId, runId, final, finalText, partialId, partialText);
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
          this.store.appendToolResult(sessionId, runId, result);
          messages.push(result);
        }
        if (task.stopped) { outcome = 'stopped'; break; }
        if (turn === 31) throw new RuntimeError(ErrorCodes.TOOL_LIMIT_EXCEEDED);
      }
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
    this.emit(sessionId, 'run.updated', {
      runId, status: outcome, tipEntryId: this.store.tip(sessionId),
      ...(outcome === 'failed' ? { errorCode: 'RUN_FAILED' } : {}),
    });
    try { streamController.close(); } catch { /* consumer already disconnected */ }
    release();
  }
}
