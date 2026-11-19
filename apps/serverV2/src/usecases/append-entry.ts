import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { EventHub } from '../infrastructure/events/event-hub.js';
import type { AppendEntryInput, SessionService } from '../modules/sessions/service.js';
import type { StateService } from '../modules/state/service.js';

/** Advancing the tip can replace the effective message scope without a state PUT/PATCH. */
export function createAppendEntry({ sessions, state, transaction, events }: {
  sessions: Pick<SessionService, 'appendEntry'>;
  state: Pick<StateService, 'getCurrentMessage' | 'describeChange'>;
  transaction: TransactionRunner;
  events: EventHub;
}) {
  return (sessionId: string, input: AppendEntryInput) => {
    // Inherited state cannot change the effective view when appending to the current tip.
    if (input.state === undefined || input.state === null) return sessions.appendEntry(sessionId, input);
    const result = transaction(() => {
      const before = state.getCurrentMessage(sessionId);
      const entry = sessions.appendEntry(sessionId, input);
      const event = state.describeChange('message', before, state.getCurrentMessage(sessionId));
      return { entry, event };
    });
    if (result.event) events.publish(sessionId, result.event);
    return result.entry;
  };
}

export type AppendEntry = ReturnType<typeof createAppendEntry>;
