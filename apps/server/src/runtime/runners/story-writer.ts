import { normalizeError } from '../../common/error-codes.js';
import { debugLog } from '../../common/debug.js';
import type { RunStore } from '../persistence/run-store.js';
import type { UsageStore } from '../persistence/usage-store.js';
import type { RunEvent, RunnerArgs } from '../types.js';

/** A per-execution closure; no run-local buffers are held on shared service instances. */
export function createStoryWriter(args: RunnerArgs, store: RunStore, usage: UsageStore, emit: RunEvent) {
  let id: string | null = null, text = '';
  const { sessionId, runId, prepared, task, runContext, streamController } = args;
  return {
    get id() { return id; },
    get text() { return text; },
    reset() { id = null; text = ''; },
    async write(chunk: string) {
      if (!chunk || task.stopped) return;
      const offset = text.length;
      text += chunk;
      if (!id) {
        id = store.createPartial(sessionId, runId, text);
        prepared.execution.progress.latestEntryId = id;
        emit(sessionId, 'message.created', { runId, message: { id, role: 'assistant', text: '', status: 'streaming', createdAt: Date.now() } });
      } else store.updatePartial(id, text);
      emit(sessionId, 'message.delta', { runId, messageId: id, offset, text: chunk });
      try { runContext.firstVisible(usage); }
      catch (error) { debugLog('首段叙事统计写入失败', { sessionId, runId, code: normalizeError(error).errorCode }); }
      try { streamController.enqueue(new TextEncoder().encode(chunk)); }
      catch { task.stopped = true; task.controller.abort(); return; }
      if (streamController.desiredSize !== null && streamController.desiredSize <= 0 && !task.stopped) {
        await new Promise<void>(resolve => {
          const wake = () => { task.drain = undefined; task.controller.signal.removeEventListener('abort', wake); resolve(); };
          task.drain = wake;
          task.controller.signal.addEventListener('abort', wake, { once: true });
          if (task.controller.signal.aborted) wake();
        });
      }
    },
  };
}
