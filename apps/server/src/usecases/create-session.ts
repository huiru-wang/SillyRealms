import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { AppError } from '../errors.js';
import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { EventHub } from '../infrastructure/events/event-hub.js';
import { createSessionSchema, type RunMessage, type SessionService } from '../modules/sessions/service.js';
import { StateValidationError, type StateService } from '../modules/state/service.js';
import type { WorldService } from '../modules/worlds/service.js';

const inputSchema = createSessionSchema.omit({ state: true }).extend({ openingId: createSessionSchema.shape.worldId });
export type CreateSessionInput = z.input<typeof inputSchema>;
export type SessionCreatedEvent = {
  event: 'session.created';
  data: { sessionId: string; tipEntryId: string; timestamp: number; opening: { runId: string; message: RunMessage } };
};

/** One local transaction: ready session, initialized state and its first saved message. */
export function createSessionUsecase({ worlds, sessions, state, transaction, events }: {
  worlds: Pick<WorldService, 'require' | 'requireOpening'>;
  sessions: Pick<SessionService, 'create' | 'require' | 'createOpening'>;
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
        runtimeConfig: value.runtimeConfig,
        title: value.title === undefined ? opening.name : value.title, state: snapshots.session,
      });
      const timestamp = Date.now(), playerName = character.name;
      // Function replacement keeps $ sequences in names literal; substitutions are not re-evaluated.
      const content = opening.content.replaceAll('{{user}}', () => playerName);
      const updates = snapshots.message.map(({ key, value }) => ({ status: 'success' as const, path: key, value }));
      const runId = randomUUID();
      const message = sessions.createOpening(session.id, runId, {
        id: randomUUID(), parentId: null, timestamp,
        payload: { message: { role: 'assistant', content, timestamp } },
        state: snapshots.message,
      }, {
        stateUpdate: { status: updates.length ? 'success' : 'no_updates', updates },
        actionSuggestions: { status: 'no_suggestions', items: [] },
      });
      return { item: sessions.require(session.id), opening: { runId, message } };
    });
    const event: SessionCreatedEvent = { event: 'session.created', data: {
      sessionId: result.item.id, tipEntryId: result.opening.message.id, timestamp: result.opening.message.timestamp,
      opening: structuredClone(result.opening),
    } };
    events.publish(result.item.id, event);
    return result;
  };
}

export type CreateSession = ReturnType<typeof createSessionUsecase>;
