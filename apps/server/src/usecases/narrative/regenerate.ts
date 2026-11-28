import { z } from 'zod';
import type { RunWritePermit } from '../../infrastructure/cache/index.js';
import type { NarrativeDependencies, RegenerateInput, ReadyNarrative } from './types.js';

const id = z.string().min(1).refine(value => value === value.trim());
export const regenerateSchema = z.object({
  sessionId: id, runId: id, expectedAssistantEntryId: id, expectedTipEntryId: id,
}).strict();

/** Capture the effective state change in the same transaction as the replacement. */
export function prepareRegeneration(deps: NarrativeDependencies, input: RegenerateInput,
  permit: RunWritePermit, assistantEntryId: string): ReadyNarrative {
  return deps.transaction(() => {
    const { sessionId, runId, expectedAssistantEntryId, expectedTipEntryId } = input;
    const before = deps.state.getCurrentMessage(sessionId);
    const ready = deps.sessions.restartRun(sessionId, runId, expectedAssistantEntryId, assistantEntryId, expectedTipEntryId, permit);
    const notifications: ReadyNarrative['notifications'] = ready.deletedMessageIds.map(messageId => ({
      event: 'message.deleted', data: { sessionId, runId, assistantEntryId, messageId, tipEntryId: ready.tipEntryId },
    }));
    const change = deps.state.describeChange('message', before, deps.state.getCurrentMessage(sessionId));
    if (change) notifications.push(change);
    return { ...ready, notifications };
  });
}
