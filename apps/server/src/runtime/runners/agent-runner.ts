import { debugLog } from '../../common/debug.js';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ErrorCodes, errorInfo, isErrorCode, normalizeError, type ErrorCode } from '../../common/error-codes.js';
import { RuntimeError } from '../shared/errors.js';
import type { ModelClient } from '../model/model-client.js';
import type { UsageStore } from '../persistence/usage-store.js';
import type { RunStore } from '../persistence/run-store.js';
import type { RunEvent, RunnerArgs, RunnerResult } from '../types.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ContextManager } from '../context/context-manager.js';
import { requiredToolChoice } from '../model/pi-gateway.js';
import { createStoryWriter } from './story-writer.js';

export class AgentRunner {
  constructor(private store: RunStore, private client: ModelClient, private executor: ToolExecutor,
    private emit: RunEvent, private usage: UsageStore, private context: ContextManager) {}
  async execute(args: RunnerArgs): Promise<RunnerResult> {
    const { sessionId, runId, prepared, task, runContext } = args;
    const { model, config, execution, workspace, modules, active } = prepared;
    const writer = createStoryWriter(args, this.store, this.usage, this.emit);
    let first = true, stateToolCalled = false, high = '';
    try {
      while (!task.stopped) {
        const request = first ? execution.request! : await this.context.prepareContinuation(prepared,
          active.size && !stateToolCalled ? requiredToolChoice(model) : undefined);
        const meta = runContext.request(first ? 'generation' : 'continuation', first ? prepared.contextComposition : undefined);
        first = false;
        let final: AssistantMessage | undefined;
        for await (const event of this.client.events(model, request.context, {
          credentialRef: config.model.credentialRef, signal: task.controller.signal,
          maxTokens: request.output, temperature: request.temperature, toolChoice: request.toolChoice, prepared: request,
        }, meta)) {
          if (task.stopped) break;
          if (event.type === 'text_delta' && event.delta) {
            let chunk = high + event.delta; high = '';
            const last = chunk.charCodeAt(chunk.length - 1);
            if (last >= 0xd800 && last <= 0xdbff) { high = chunk.slice(-1); chunk = chunk.slice(0, -1); }
            await writer.write(new TextDecoder().decode(new TextEncoder().encode(chunk)));
          } else if (event.type === 'done') {
            if (high) { await writer.write('\uFFFD'); high = ''; }
            final = event.message;
          } else if (event.type === 'error') throw new RuntimeError(normalizeError(event.error, ErrorCodes.PROVIDER_ERROR).errorCode);
        }
        if (task.stopped) break;
        if (!final) throw new RuntimeError(ErrorCodes.PROVIDER_ERROR);
        const calls = final.content.filter(part => part.type === 'toolCall');
        const text = final.content.filter(part => part.type === 'text').map(part => part.text).join('');
        const savedId = this.store.completeAssistant(sessionId, runId, final, text, writer.id, writer.text);
        execution.progress.latestEntryId = savedId;
        try { this.usage.attachEntry(sessionId, runId, meta.requestId, savedId); }
        catch (error) { debugLog('用量关联失败', { runId, errorCode: normalizeError(error).errorCode }); }
        if (!writer.id && text) this.emit(sessionId, 'message.created', {
          runId, message: { id: savedId, role: 'assistant', text, status: 'completed', createdAt: final.timestamp } });
        if (writer.id) this.emit(sessionId, 'message.final', { runId, messageId: writer.id, status: 'completed' });
        writer.reset();
        if (!calls.length) {
          if (active.size && !stateToolCalled) throw new RuntimeError(ErrorCodes.PROVIDER_ERROR);
          break;
        }
        execution.progress.continuation.push(final);
        for (const call of calls) {
          if (task.stopped) break;
          const result = this.executor.execute(call, workspace, modules, active);
          if (call.name === 'update_state') stateToolCalled = true;
          this.store.appendToolResult(sessionId, runId, result);
          execution.progress.latestEntryId = this.store.tip(sessionId) ?? undefined;
          execution.progress.continuation.push(result);
          if (result.isError) {
            let code: ErrorCode = ErrorCodes.INVALID_TOOL_CALL;
            try {
              const part = result.content.find(item => item.type === 'text');
              const detail = part ? JSON.parse(part.text) : null;
              if (isErrorCode(detail?.code)) code = detail.code;
            } catch { /* Non-JSON errors use the generic public code. */ }
            this.emit(sessionId, 'tool.failed', { runId, toolCallId: call.id, toolName: call.name, ...errorInfo(code) });
          }
        }
      }
      return { outcome: task.stopped ? 'stopped' : 'completed', failure: null, partialId: writer.id, workspace };
    } catch (error) {
      return { outcome: task.stopped ? 'stopped' : 'failed',
        failure: task.stopped ? null : normalizeError(error, ErrorCodes.PROVIDER_ERROR), partialId: writer.id, workspace };
    }
  }
}
