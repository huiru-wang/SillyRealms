import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { RunWritePermit } from '../../infrastructure/cache/index.js';
import type { NarrativeDependencies, RegenerateInput, ReadyNarrative } from './types.js';

const id = z.string().min(1).refine(value => value === value.trim());
export const regenerateSchema = z.object({
  sessionId: id, userEntryId: id, assistantEntryId: id.nullable(), expectedTipEntryId: id,
}).strict();

/** Admission changes are atomic; Session itself only knows how to delete an entry. */
export function prepareRegeneration(deps: NarrativeDependencies, input: RegenerateInput,
  permit: RunWritePermit, assistantEntryId: string): ReadyNarrative {
  return deps.transaction(() => {
    const { sessionId } = input, entries = deps.sessions.getHistory(sessionId);
    if (deps.sessions.require(sessionId).tipEntryId !== input.expectedTipEntryId) throw new AppError('TIP_CONFLICT');
    const userIndex = entries.findIndex(entry => entry.id === input.userEntryId), user = entries[userIndex];
    if (!user || user.role !== 'user' || entries.some((entry, index) => index < userIndex && entry.runId === user.runId)) {
      throw new AppError('INVALID_REGENERATION_TARGET');
    }
    const message = user.payload.message;
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.role !== 'user' ||
      typeof message.content !== 'string' || !message.content.trim()) throw new AppError('INVALID_REGENERATION_TARGET');
    const tail = entries.slice(userIndex + 1), replies = tail.filter(entry => entry.type === 'message');
    if (tail.some(entry => entry.runId !== user.runId) ||
      (input.assistantEntryId === null ? replies.length !== 0 :
        replies.length !== 1 || replies[0]!.role !== 'assistant' || replies[0]!.id !== input.assistantEntryId)) {
      throw new AppError('INVALID_REGENERATION_TARGET');
    }
    const before = deps.state.getCurrentMessage(sessionId);
    let tipEntryId: string | null = input.expectedTipEntryId;
    const notifications: ReadyNarrative['notifications'] = [];
    if (input.assistantEntryId !== null) {
      tipEntryId = deps.sessions.deleteEntry(sessionId, input.assistantEntryId, input.expectedTipEntryId, permit).tipEntryId;
      notifications.push({ event: 'message.deleted', data: {
        sessionId, runId: user.runId, assistantEntryId, messageId: input.assistantEntryId, tipEntryId,
      } });
    }
    deps.sessions.setNarrativeOutcome(sessionId, user.id, null, permit);
    const stateChange = deps.state.describeChange('message', before, deps.state.getCurrentMessage(sessionId));
    if (stateChange) notifications.push(stateChange);
    return { userMessage: { id: user.id, role: 'user', content: message.content, timestamp: user.timestamp },
      tipEntryId, deletedMessageIds: input.assistantEntryId === null ? [] : [input.assistantEntryId], notifications };
  });
}
