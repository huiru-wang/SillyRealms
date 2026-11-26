import { failureReason, modelOutcome } from '../model-outcome.js';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { RuntimeCache } from '../../infrastructure/cache/index.js';
import type { EventHub } from '../../infrastructure/events/event-hub.js';
import { collectModel, raceAbort } from '../../infrastructure/model/collect.js';
import type { ModelClient } from '../../infrastructure/model/client.js';
import type { CredentialService } from '../../modules/credentials/service.js';
import { prepareReplyAssistContext, type ReplyAssistSources } from '../context/index.js';

const submission = z.object({ requestId: z.string().uuid(), draftText: z.string().max(100000) }).strict();
type Dependencies = ReplyAssistSources & {
  credentials: Pick<CredentialService, 'get'>; cache: RuntimeCache; events: EventHub; modelClient: ModelClient;
};
type Active = { requestId: string; controller: AbortController; completion: Promise<void> };

export function createReplyAssist(deps: Dependencies) {
  const active = new Map<string, Active>();
  let closing = false;
  function submit(sessionId: string, body: unknown) {
    const { requestId, draftText } = submission.parse(body);
    if (closing) throw new AppError('SERVER_SHUTTING_DOWN');
    const session = deps.sessions.require(sessionId);
    const owner = deps.cache.acquireReplyAssist(sessionId, requestId, session.worldId);
    const controller = new AbortController(), { signal } = controller;
    const run: Active = { requestId, controller, completion: Promise.resolve() };
    active.set(sessionId, run);
    const release = () => {
      if (active.get(sessionId) === run) active.delete(sessionId);
      deps.cache.releaseReplyAssist(owner);
    };
    const publish = (name: string, payload: Record<string, unknown>) => deps.events.publish(sessionId, {
      event: 'reply_assist.' + name, data: { sessionId, requestId, timestamp: Date.now(), ...payload },
    });
    try {
      const presetId = session.runtimeConfig.replyAssistPresetId ?? deps.settings.getOptional()?.defaultReplyAssistPresetId;
      if (!presetId) throw new AppError('REPLY_ASSIST_NOT_CONFIGURED');
      const request = prepareReplyAssistContext(deps, { sessionId, presetId, draftText, signal });
      const started = performance.now();
      run.completion = Promise.resolve().then(async () => {
        let content = '', reason: string | undefined;
        try {
          signal.throwIfAborted();
          const apiKey = await raceAbort(deps.credentials.get(request.credentialRef), signal);
          if (!apiKey?.trim()) throw new AppError('CREDENTIAL_NOT_CONFIGURED');
          const result = await collectModel(deps.modelClient, request.model, request.messages, {
            signal, apiKey, maxTokens: request.maxTokens, ...request.modelParameters,
          }, { onDelta(delta) {
            if (delta.content && !signal.aborted) {
              content += delta.content;
              publish('delta', { delta: { content: delta.content } });
            }
          } });
          reason = modelOutcome(result, signal);
          if (result.snapshot.content.trim() || !reason) content = result.snapshot.content;
        } catch (error) {
          reason = failureReason(error, false);
        }
        if (signal.aborted) reason = signal.reason === 'server_shutdown' ? 'server_shutdown' : 'cancelled';
        release();
        try {
          console.info('reply_assist.finished', JSON.stringify({ sessionId, requestId, presetId,
            durationMs: Math.round(performance.now() - started), outcome: reason ?? 'completed' }));
        } catch { /* A diagnostic sink cannot interrupt terminal delivery. */ }
        publish(reason ? 'stopped' : 'completed', { snapshot: { content }, ...(reason ? { stop_reason: reason } : {}) });
      }).finally(release);
      return { accepted: true, sessionId, requestId };
    } catch (error) { release(); throw error; }
  }
  return { submit, stop(sessionId: string, requestId: string) {
    const run = active.get(sessionId);
    if (!run || run.requestId !== requestId) throw new AppError('REPLY_ASSIST_NOT_FOUND');
    run.controller.abort('cancelled');
    return { sessionId, requestId, stopping: true };
  }, async shutdown() {
    closing = true;
    for (const run of active.values()) run.controller.abort('server_shutdown');
    await Promise.all([...active.values()].map(run => run.completion));
  } };
}
