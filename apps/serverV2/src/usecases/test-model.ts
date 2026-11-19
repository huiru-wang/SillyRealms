import { AppError } from '../errors.js';
import type { PiClient, PiEvent, PiMessage, PiUsage } from '../infrastructure/pi/client.js';
import type { CredentialService } from '../modules/credentials/service.js';
import type { ModelService } from '../modules/models/service.js';

const TEST_TIMEOUT_MS = 30_000;
const TEST_MAX_TOKENS = 64;

export type ModelConnectionResult = {
  providerId: string;
  modelId: string;
  connected: true;
  durationMs: number;
  usage: PiUsage | null;
};
export type TestModel = (modelConfigId: string, signal?: AbortSignal) => Promise<ModelConnectionResult>;
export type TestModelDependencies = {
  models: Pick<ModelService, 'require'>;
  credentials: Pick<CredentialService, 'get'>;
  pi: Pick<PiClient, 'resolve' | 'assertMessageOrder' | 'stream'>;
};

/** Tests one saved configuration without creating narrative entries or execution records. */
export function createTestModel({ models, credentials, pi }: TestModelDependencies): TestModel {
  return async (modelConfigId, signal) => {
    const startedAt = performance.now();
    const controller = new AbortController();
    let timedOut = false;
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, TEST_TIMEOUT_MS);
    timer.unref();
    const cancelled = Symbol('cancelled');
    let cancel!: () => void;
    const aborted = new Promise<typeof cancelled>(resolve => { cancel = () => resolve(cancelled); });
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (controller.signal.aborted) cancel();
    let iterator: AsyncIterator<PiEvent> | undefined;
    const throwIfAborted = () => {
      if (controller.signal.aborted) throw new AppError(timedOut ? 'PROVIDER_ERROR' : 'RUN_STOPPED');
    };
    const waitFor = async <T>(pending: PromiseLike<T> | T): Promise<T> => {
      const result = await Promise.race([pending, aborted]);
      throwIfAborted();
      if (result === cancelled) throw new AppError('RUN_STOPPED');
      return result as T;
    };

    try {
      throwIfAborted();
      const config = models.require(modelConfigId);
      const model = pi.resolve(config.providerId, config.modelId);
      if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens <= 0) {
        throw new AppError('MODEL_CAPABILITY_UNSUPPORTED');
      }
      const messages: PiMessage[] = [{ role: 'user', content: 'Reply with OK.' }];
      pi.assertMessageOrder(model, messages);
      const apiKey = await waitFor(credentials.get(config.credentialRef));
      if (!apiKey?.trim()) throw new AppError('CREDENTIAL_NOT_CONFIGURED');
      iterator = pi.stream(model, messages, {
        apiKey, signal: controller.signal, maxTokens: Math.min(TEST_MAX_TOKENS, model.maxTokens),
        thinkingEnabled: false,
      })[Symbol.asyncIterator]();
      let text = '';
      while (true) {
        const next = await waitFor(iterator.next());
        if (next.done) throw new AppError('MODEL_OUTPUT_INCOMPLETE');
        const event = next.value;
        if (event.type === 'text_delta') {
          text += event.delta;
          continue;
        }
        if (event.type === 'error') throw new AppError(event.errorCode);
        if (event.stopReason !== 'stop') throw new AppError('MODEL_OUTPUT_INCOMPLETE');
        if (event.hasToolCalls || !event.text.trim() || (text && text !== event.text)) {
          throw new AppError('MODEL_OUTPUT_INVALID');
        }
        return {
          providerId: config.providerId, modelId: config.modelId, connected: true,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)), usage: event.usage,
        };
      }
    } catch (error) {
      throwIfAborted();
      // Stable codes only: do not echo provider text, the reply, credential references or secrets.
      throw new AppError(error instanceof AppError ? error.code : 'PROVIDER_ERROR');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      controller.signal.removeEventListener('abort', cancel);
      controller.abort();
      if (iterator?.return) {
        try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Best-effort cleanup. */ }
      }
    }
  };
}
