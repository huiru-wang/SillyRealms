import { inputIdentity } from '../context/compaction/estimator.js';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, ToolChoice } from '@earendil-works/pi-ai';
import { providerErrorCode, type ModelGateway } from './pi-gateway.js';
import type { UsageStore, RequestMeta, RequestMetrics } from '../persistence/usage-store.js';
import { debugEnabled, debugLog } from '../../common/debug.js';
import { ErrorCodes, normalizeError } from '../../common/error-codes.js';
import type { CredentialStore } from '../../infrastructure/credentials/store.js';
import { assertPreparedRequest, type PreparedRequest } from '../context/budget.js';
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
  async preview(model: Model<Api>, context: Context, options: { maxTokens: number; temperature?: number; toolChoice?: ToolChoice; signal?: AbortSignal }): Promise<string | undefined> {
    return abortable(Promise.resolve(this.gateway.preview?.(model, context, options)), options.signal);
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
    const capture = debugEnabled();
    const trace = { sessionId: meta?.sessionId, runId: meta?.runId, requestId: meta?.requestId,
      requestIndex: meta?.requestIndex, phase: meta?.phase };
    const logOptions = { context: trace, secrets: [apiKey] };
    let output: AssistantMessage | undefined, partial: AssistantMessage | undefined;
    let rawText = '', rawThinking = '';
    let failureCode: string | undefined;
    let firstTextMs: number | undefined;
    let settled = false;
    if (meta && options.prepared && meta.phase !== 'summary') meta.inputIdentity = inputIdentity(model, context,
      { mode: options.prepared.mode, strategy: options.prepared.strategy ?? 'rolling_summary', toolChoice: options.toolChoice });
    if (meta) this.usage?.beginRequest(meta, model.id, model.contextWindow);
    debugLog('MODEL BEGIN', { provider: model.provider, model: model.id }, logOptions);
    debugLog('MODEL INPUT', { source: 'pi-context', systemPrompt: context.systemPrompt, messages: context.messages,
      tools: context.tools, maxOutputTokens: options.maxTokens, temperature: options.temperature, toolChoice: options.toolChoice }, logOptions);
    const finish = (status: RequestMetrics['status'], usage?: import('@earendil-works/pi-ai').Usage) => {
      if (settled) return;
      settled = true;
      const durationMs = Math.max(0, Math.round(performance.now() - started));
      debugLog('MODEL OUTPUT', { source: output ? 'pi-response' : 'partial', status,
        response: output ?? (partial?.content?.length ? partial : undefined) ?? { role: 'assistant', content: [
          ...(rawThinking ? [{ type: 'thinking', thinking: rawThinking }] : []),
          ...(rawText ? [{ type: 'text', text: rawText }] : []),
        ] } }, logOptions);
      if (meta) {
        try { this.usage?.finishRequest(meta, status, usage, firstTextMs, Math.max(0, Math.round(performance.now() - started))); }
        catch (error) { debugLog('模型用量写入失败', { runId: meta.runId, requestId: meta.requestId, errorCode: normalizeError(error).errorCode }); }
      }
      debugLog('MODEL END', { status, errorCode: failureCode, durationMs, firstTextMs, usageReported: !!usage, usage }, logOptions);
    };
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
    const marker = Symbol('aborted');
    let wake!: () => void;
    const aborted = new Promise<typeof marker>(resolve => { wake = () => resolve(marker); });
    options.signal.addEventListener('abort', wake, { once: true });
    if (options.signal.aborted) wake();
    try {
      try { iterator = this.gateway.stream(model, context, { ...options, apiKey, wireFingerprint: options.prepared?.wireFingerprint, debugContext: trace })[Symbol.asyncIterator](); }
      catch (error) { throw new RuntimeError(providerErrorCode(error)); }
      while (true) {
        let result;
        try { result = await Promise.race([iterator.next(), aborted]); }
        catch (error) { throw new RuntimeError(providerErrorCode(error)); }
        if (result === marker) { finish('aborted'); return; }
        if (result.done) return;
        const event = result.value;
        if (capture) {
          if ('partial' in event) partial = event.partial;
          if (event.type === 'text_delta') rawText += event.delta;
          if (event.type === 'thinking_delta') rawThinking += event.delta;
          if (event.type === 'done' || event.type === 'error') output = event.type === 'done' ? event.message : event.error;
        }
        if (event.type === 'text_delta' && event.delta && firstTextMs === undefined)
          firstTextMs = Math.max(0, Math.round(performance.now() - started));
        if (event.type === 'done' || event.type === 'error') {
          const message = event.type === 'done' ? event.message : event.error;
          if (event.type === 'error') failureCode = providerErrorCode(message);
          const reported = this.gateway.usageReported?.(message) ?? Object.values(message.usage ?? {}).some(v => typeof v === 'number' && v > 0);
          finish(event.type === 'done' && ['stop', 'toolUse'].includes(message.stopReason) ? 'completed' : event.type === 'error' && event.reason === 'aborted' ? 'aborted' : 'error', reported ? message.usage : undefined);
          if (event.type === 'error') throw new RuntimeError(providerErrorCode(message));
        }
        yield event;
      }
    } catch (error) {
      failureCode = providerErrorCode(error);
      throw error;
    } finally {
      finish(options.signal.aborted ? 'aborted' : 'error');
      options.signal.removeEventListener('abort', wake);
      if (options.signal.aborted && iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
    }
  }
}
