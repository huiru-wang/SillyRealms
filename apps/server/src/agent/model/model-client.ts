import type { Api, AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai';
import type { ModelGateway } from './pi-gateway.js';

/**
 * The single boundary for model calls (generation and compaction).
 * All future usage accounting belongs here, not in the runner or context builder.
 */
export class ModelClient {
  constructor(private gateway: ModelGateway) {}

  resolve(provider: string, model: string) {
    return this.gateway.resolve(provider, model);
  }

  /** Stop awaiting providers which ignore cancellation; discard late responses. */
  async *events(model: Model<Api>, context: Context, options: {
    apiKey: string; signal: AbortSignal; maxTokens: number; temperature?: number;
  }): AsyncGenerator<AssistantMessageEvent> {
    const iterator = this.gateway.stream(model, context, options)[Symbol.asyncIterator]();
    const marker = Symbol('aborted');
    let wake!: () => void;
    const aborted = new Promise<typeof marker>(resolve => { wake = () => resolve(marker); });
    options.signal.addEventListener('abort', wake, { once: true });
    if (options.signal.aborted) wake();
    try {
      while (true) {
        const result = await Promise.race([iterator.next(), aborted]);
        if (result === marker || result.done) return;
        yield result.value;
      }
    } finally {
      options.signal.removeEventListener('abort', wake);
      if (options.signal.aborted && iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
    }
  }
}
