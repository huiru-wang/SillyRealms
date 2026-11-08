import type { Api, AssistantMessageEvent, Context, Model, ToolChoice } from '@earendil-works/pi-ai';
import type { ModelGateway } from './pi-gateway.js';
import type { UsageStore, RequestMeta, RequestMetrics } from '../persistence/usage-store.js';
import { debugLog } from '../../common/debug.js';

/**
 * The single boundary for model calls (generation and compaction).
 * All future usage accounting belongs here, not in the runner or context builder.
 */
export class ModelClient {
  constructor(private gateway: ModelGateway, private usage?: UsageStore) {}

  resolve(provider: string, model: string) {
    return this.gateway.resolve(provider, model);
  }

  /** Stop awaiting providers which ignore cancellation; discard late responses. */
  async *events(model: Model<Api>, context: Context, options: {
    apiKey: string; signal: AbortSignal; maxTokens: number; temperature?: number; toolChoice?: ToolChoice;
  }, meta?: RequestMeta): AsyncGenerator<AssistantMessageEvent> {
    const started = performance.now();
    let firstTextMs: number | undefined;
    let settled = false;
    if (meta) this.usage?.beginRequest(meta, model.id, model.contextWindow);
    const finish = (status: RequestMetrics['status'], usage?: import('@earendil-works/pi-ai').Usage) => {
      if (settled) return;
      settled = true;
      if (meta) {
        try { this.usage?.finishRequest(meta, status, usage, firstTextMs, Math.max(0, Math.round(performance.now() - started))); }
        catch (error) { debugLog('模型用量写入失败', { runId: meta.runId, requestId: meta.requestId, error: String(error) }); }
      }
    };
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
    const marker = Symbol('aborted');
    let wake!: () => void;
    const aborted = new Promise<typeof marker>(resolve => { wake = () => resolve(marker); });
    options.signal.addEventListener('abort', wake, { once: true });
    if (options.signal.aborted) wake();
    try {
      iterator = this.gateway.stream(model, context, options)[Symbol.asyncIterator]();
      while (true) {
        const result = await Promise.race([iterator.next(), aborted]);
        if (result === marker) { finish('aborted'); return; }
        if (result.done) return;
        const event = result.value;
        if (event.type === 'text_delta' && event.delta && firstTextMs === undefined)
          firstTextMs = Math.max(0, Math.round(performance.now() - started));
        if (event.type === 'done') finish('completed', event.message.usage);
        if (event.type === 'error') finish(event.reason === 'aborted' ? 'aborted' : 'error', event.error.usage);
        yield event;
      }
    } finally {
      finish(options.signal.aborted ? 'aborted' : 'error');
      options.signal.removeEventListener('abort', wake);
      if (options.signal.aborted && iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
    }
  }
}
