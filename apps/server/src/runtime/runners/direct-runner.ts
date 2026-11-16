import { debugLog } from '../../common/debug.js';
import { createHash } from 'node:crypto';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ErrorCodes, normalizeError } from '../../common/error-codes.js';
import { RuntimeError } from '../shared/errors.js';
import type { ModelClient } from '../model/model-client.js';
import type { RunStore } from '../persistence/run-store.js';
import type { UsageStore } from '../persistence/usage-store.js';
import type { RunEvent, RunnerArgs, RunnerResult } from '../types.js';
import { initialExtensions, rejectExtensions } from '../postprocess/contracts.js';
import { ExtensionStreamSplitter } from '../postprocess/stream-splitter.js';
import { processResponse } from '../postprocess/processor.js';
import { createStoryWriter } from './story-writer.js';

export class DirectRunner {
  constructor(private store: RunStore, private client: ModelClient, private usage: UsageStore, private emit: RunEvent) {}
  async execute(args: RunnerArgs): Promise<RunnerResult> {
    const { sessionId, runId, prepared, task, runContext } = args;
    const { config, execution } = prepared;
    const writer = createStoryWriter(args, this.usage, this.emit);
    const splitter = new ExtensionStreamSplitter();
    let extensions = initialExtensions(prepared.postprocess);
    let workspace = structuredClone(execution.state.baseline);
    const request = execution.request;
    if (!request) throw new RuntimeError(ErrorCodes.INVALID_REQUEST);
    try {
      let final: AssistantMessage | undefined, hadDelta = false, finished = false;
      const deltaHash = createHash('sha256');
      const meta = runContext.request('generation', prepared.contextComposition);
      for await (const event of this.client.events(prepared.model, request.context, {
        credentialRef: config.model.credentialRef, signal: task.controller.signal,
        maxTokens: request.output, temperature: request.temperature, reasoning: request.reasoning, prepared: request,
      }, meta)) {
        if (task.stopped) break;
        if (event.type === 'text_delta') {
          if (finished) throw new RuntimeError(ErrorCodes.NARRATIVE_INCOMPLETE);
          hadDelta = true; deltaHash.update(event.delta, 'utf16le');
          await writer.write(splitter.push(event.delta));
          if (splitter.hidden && task.phase !== 'extensions') {
            task.phase = execution.progress.phase = 'extensions';
            this.emit(sessionId, 'run.phase', { runId, phase: 'extensions' });
          }
        } else if (event.type === 'done') {
          if (finished) throw new RuntimeError(ErrorCodes.NARRATIVE_INCOMPLETE);
          finished = true; final = event.message;
          if (event.reason !== 'stop') throw new RuntimeError(ErrorCodes.NARRATIVE_INCOMPLETE);
        } else if (event.type === 'error') throw new RuntimeError(normalizeError(event.error, ErrorCodes.PROVIDER_ERROR).errorCode);
      }
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      if (!final || final.stopReason !== 'stop' || final.content.some(part => part.type === 'toolCall'))
        throw new RuntimeError(ErrorCodes.NARRATIVE_INCOMPLETE);
      const finalText = final.content.filter(part => part.type === 'text').map(part => part.text).join('');
      if (!hadDelta) {
        await writer.write(splitter.push(finalText));
        if (splitter.hidden) {
          task.phase = execution.progress.phase = 'extensions';
          this.emit(sessionId, 'run.phase', { runId, phase: 'extensions' });
        }
      }
      else if (deltaHash.digest('hex') !== createHash('sha256').update(finalText, 'utf16le').digest('hex'))
        throw new RuntimeError(ErrorCodes.NARRATIVE_INCOMPLETE);
      await writer.write(splitter.finish());
      if (task.stopped) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
      if (!writer.text.trim()) throw new RuntimeError(ErrorCodes.NARRATIVE_EMPTY);
      if (splitter.overflow) throw new RuntimeError(ErrorCodes.EXTENSION_TAIL_TOO_LARGE);
      if (splitter.incompletePrefix) throw new RuntimeError(ErrorCodes.EXTENSION_PROTOCOL_INVALID);
      const processed=processResponse(splitter.tail,prepared.postprocess,structuredClone(execution.state.baseline),execution.state.modules);
      workspace=processed.workspace;extensions=processed.extensions;
      // Persist only clean text, never the provider's hidden tail or reasoning content.
      const clean: AssistantMessage = { ...final, content: [{ type: 'text', text: writer.text }] };
      const savedId = this.store.completeAssistant(sessionId, runId, clean, writer.id);
      execution.progress.latestEntryId = savedId;
      task.liveMessage = undefined;
      try { this.usage.attachEntry(sessionId, runId, meta.requestId, savedId); }
      catch (error) { debugLog('用量关联失败', { runId, errorCode: normalizeError(error).errorCode }); }
      if (extensions.stateUpdate.status === 'failed') return { outcome: 'failed',
        failure: normalizeError(new RuntimeError(extensions.stateUpdate.errorCode as typeof ErrorCodes.STATE_UPDATE_INVALID)),
        partialId: savedId, workspace, extensions };
      return { outcome: 'completed', failure: null, partialId: savedId, workspace, extensions };
    } catch (error) {
      const cancelled = task.stopped;
      const failure = cancelled ? null : normalizeError(error, ErrorCodes.PROVIDER_ERROR);
      return { outcome: cancelled ? 'stopped' : 'failed', failure, partialId: writer.id,
        workspace: structuredClone(execution.state.baseline), extensions: rejectExtensions(extensions, cancelled, failure?.errorCode) };
    }
  }
}
