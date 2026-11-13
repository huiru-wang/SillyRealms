import type { Api, AssistantMessageEvent, Context, Model, ToolChoice } from '@earendil-works/pi-ai';
import type { ModelGateway } from './pi-gateway.js';
import type { UsageStore, RequestMeta, RequestMetrics } from '../persistence/usage-store.js';
import { debugLog } from '../../common/debug.js';
import { ErrorCodes, normalizeError } from '../../common/error-codes.js';
import type { CredentialStore } from '../../infrastructure/credentials/store.js';
import { assertPreparedRequest, type PreparedRequest, type Measurement } from '../context/budget.js';
import { RuntimeError } from '../shared/errors.js';

async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) throw new RuntimeError(ErrorCodes.RUN_STOPPED);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new RuntimeError(ErrorCodes.RUN_STOPPED));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/**
 * The single boundary for model calls (generation and compaction).
 * All future usage accounting belongs here, not in the runner or context builder.
 */
export class ModelClient {
  constructor(private gateway: ModelGateway, private usage?: UsageStore, private credentials?: CredentialStore) {}

  resolve(provider: string, model: string) {
    return this.gateway.resolve(provider, model);
  }

  supportsDirect(model: Model<Api>) { return this.gateway.supportsDirect?.(model) === true; }
  async checkCredential(ref: string, signal?: AbortSignal): Promise<void> {
    if (!await abortable(Promise.resolve(this.credentials?.get(ref)), signal)) throw new RuntimeError(ErrorCodes.CREDENTIAL_NOT_CONFIGURED);
  }
  async measure(model: Model<Api>, context: Context, options: { maxTokens: number; temperature?: number; toolChoice?: ToolChoice; signal?: AbortSignal }): Promise<Measurement> {
    return await abortable(Promise.resolve(this.gateway.measure?.(model, context, options) ?? { tokens: null, method: 'unsupported', quality: 'unknown' as const, version: 'unknown' }), options.signal);
  }

  /** Stop awaiting providers which ignore cancellation; discard late responses. */
  async *events(model: Model<Api>, context: Context, options: {
    apiKey?: string; credentialRef?: string; prepared?: PreparedRequest; signal: AbortSignal; maxTokens: number; temperature?: number; toolChoice?: ToolChoice;
  }, meta?: RequestMeta): AsyncGenerator<AssistantMessageEvent> {
    if (options.prepared) assertPreparedRequest(options.prepared, model, context, options);
    if (options.signal.aborted) return;
    const apiKey = options.apiKey ?? (options.credentialRef ? await abortable(Promise.resolve(this.credentials?.get(options.credentialRef)), options.signal) : undefined);
    if (!apiKey) throw new RuntimeError(ErrorCodes.CREDENTIAL_NOT_CONFIGURED);
    if (options.signal.aborted) return;
    const started = performance.now();
    let firstTextMs: number | undefined;
    let settled = false;
    if (meta) this.usage?.beginRequest(meta, model.id, model.contextWindow);
    const finish = (status: RequestMetrics['status'], usage?: import('@earendil-works/pi-ai').Usage) => {
      if (settled) return;
      settled = true;
      if (meta) {
        try { this.usage?.finishRequest(meta, status, usage, firstTextMs, Math.max(0, Math.round(performance.now() - started))); }
        catch (error) { debugLog('模型用量写入失败', { runId: meta.runId, requestId: meta.requestId, errorCode: normalizeError(error).errorCode }); }
      }
    };
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
    const marker = Symbol('aborted');
    let wake!: () => void;
    const aborted = new Promise<typeof marker>(resolve => { wake = () => resolve(marker); });
    options.signal.addEventListener('abort', wake, { once: true });
    if (options.signal.aborted) wake();
    try {
      try { iterator = this.gateway.stream(model, context, { ...options, apiKey, wireFingerprint: options.prepared?.report.wireFingerprint })[Symbol.asyncIterator](); }
      catch (error) { throw new RuntimeError(normalizeError(error, ErrorCodes.PROVIDER_ERROR).errorCode); }
      while (true) {
        let result;
        try { result = await Promise.race([iterator.next(), aborted]); }
        catch (error) { throw new RuntimeError(normalizeError(error, ErrorCodes.PROVIDER_ERROR).errorCode); }
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
