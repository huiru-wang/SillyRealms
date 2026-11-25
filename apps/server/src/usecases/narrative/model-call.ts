import { modelOutcome } from '../model-outcome.js';
export { cancellationReason, failureReason } from '../model-outcome.js';
import { NarrativeStreamSplitter, splitNarrativeContent } from './postprocess/stream-splitter.js';
import { AppError } from '../../errors.js';
import { collectModel } from '../../infrastructure/model/collect.js';
import type { ModelClient, ModelInfo, ModelMessage, ModelOptions, ModelSnapshot } from '../../infrastructure/model/client.js';
import type { EventHub } from '../../infrastructure/events/event-hub.js';
import type { RunEventFields } from './events.js';

export { copySnapshot, zeroUsage, raceAbort as whileRunning } from '../../infrastructure/model/collect.js';

export function assertRunning(signal: AbortSignal): void {
  if (signal.aborted) throw new AppError('RUN_STOPPED');
}

export function hasPublicOutput(snapshot: ModelSnapshot): boolean {
  return Boolean(snapshot.content.trim() || snapshot.reasoning_content.trim() || snapshot.tool_calls.length);
}

/** Narrative owns visible-output splitting, SSE publication and run failure semantics. */
export async function callModel(modelClient: Pick<ModelClient, 'stream'>, selected: ModelInfo,
  messages: readonly ModelMessage[], options: ModelOptions,
  publication: { events: EventHub; fields: RunEventFields; messageId: string }) {
  const splitter = new NarrativeStreamSplitter();
  let rawContent = '';
  const result = await collectModel(modelClient, selected, messages, options, {
    transformDelta(delta) {
      if (delta.content !== undefined) {
        rawContent += delta.content;
        const visible = splitter.push(delta.content);
        if (visible) delta.content = visible;
        else delete delta.content;
      }
      return delta;
    },
    transformSnapshot(snapshot) {
      rawContent = snapshot.content;
      return { ...snapshot, content: splitNarrativeContent(rawContent).content };
    },
    flush: () => splitter.finish(),
    onDelta(delta) {
      publication.events.publish(publication.fields.sessionId, { event: 'run.delta', data: {
        ...publication.fields, timestamp: Date.now(), messageId: publication.messageId,
        messages: [{ role: 'assistant', delta }],
      } });
    },
  });
  const stopReason = modelOutcome(result, options.signal);
  return { ...result, rawContent, stopReason, publishedDelta: result.receivedDelta };
}
