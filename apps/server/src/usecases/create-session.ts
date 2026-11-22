import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { EventHub } from '../infrastructure/events/event-hub.js';
import type { SessionEntry, SessionService } from '../modules/sessions/service.js';
import { StateValidationError, type StateService } from '../modules/state/service.js';
import type { WorldService } from '../modules/worlds/service.js';

const identifier = z.string().min(1).refine(value => value === value.trim());
const inputSchema = z.object({
  id: identifier.optional(), worldId: identifier, openingId: identifier,
  userCharacterId: identifier, presetId: identifier, apiModelConfigId: identifier,
  title: z.string().nullable().optional(),
}).strict();
export type CreateSessionInput = z.infer<typeof inputSchema>;
export type SessionCreatedEvent = {
  event: 'session.created';
  data: { sessionId: string; tipEntryId: string; timestamp: number; entry: SessionEntry };
};

/** One local transaction: ready session, initialized state and its first saved message. */
export function createSessionUsecase({ worlds, sessions, state, transaction, events }: {
  worlds: Pick<WorldService, 'require' | 'requireOpening'>;
  sessions: Pick<SessionService, 'create' | 'require' | 'appendNarrativeAssistant' | 'setNarrativeOutcome'>;
  state: Pick<StateService, 'prepareInitialSnapshots'>;
  transaction: TransactionRunner;
  events: EventHub;
}) {
  return (input: CreateSessionInput) => {
    const value = inputSchema.parse(input);
    const result = transaction(() => {
      const world = worlds.require(value.worldId);
      const opening = worlds.requireOpening(world.id, value.openingId);
      const character = world.characters.find(item => item !== null && typeof item === 'object' && !Array.isArray(item)
        && item.id === value.userCharacterId && item.player_selectable === true);
      if (!character || typeof character !== 'object' || Array.isArray(character) || typeof character.name !== 'string') {
        throw new AppError('INVALID_SESSION_CHARACTER');
      }
      let snapshots;
      try { snapshots = state.prepareInitialSnapshots(world.stateDefinition, opening.initial_state); }
      catch (error) {
        if (error instanceof StateValidationError) throw new AppError(error.code, error.scope + (error.path ? '.' + error.path : ''));
        throw error;
      }
      const session = sessions.create({
        id: value.id, worldId: world.id, userCharacterId: value.userCharacterId,
        presetId: value.presetId, apiModelConfigId: value.apiModelConfigId,
        title: value.title === undefined ? opening.name : value.title, state: snapshots.session,
      });
      const timestamp = Date.now(), playerName = character.name;
      // Function replacement keeps $ sequences in names literal; substitutions are not re-evaluated.
      const content = opening.content.replaceAll('{{user}}', () => playerName);
      const updates = snapshots.message.map(({ key, value }) => ({ status: 'success' as const, path: key, value }));
      const saved = sessions.appendNarrativeAssistant(session.id, {
        runId: randomUUID(), parentId: null, type: 'message', role: 'assistant', timestamp,
        payload: { message: { role: 'assistant', content, timestamp } },
        state: snapshots.message, metrics: null,
      }, {
        stateUpdate: { status: updates.length ? 'success' : 'no_updates', updates },
        actionSuggestions: { status: 'no_suggestions', items: [] },
      });
      const entry = sessions.setNarrativeOutcome(session.id, saved.id, { status: 'completed', finishedAt: timestamp });
      return { item: sessions.require(session.id), entry };
    });
    const event: SessionCreatedEvent = { event: 'session.created', data: {
      sessionId: result.item.id, tipEntryId: result.entry.id, timestamp: result.entry.timestamp,
      entry: structuredClone(result.entry),
    } };
    events.publish(result.item.id, event);
    return result;
  };
}

export type CreateSession = ReturnType<typeof createSessionUsecase>;
