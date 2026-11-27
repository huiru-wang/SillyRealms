import { worldPublication } from '../testing/fixtures.js';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../infrastructure/database/connection.js';
import { bindTransaction } from '../infrastructure/database/transaction.js';
import { EventHub } from '../infrastructure/events/event-hub.js';
import { errorHandler } from '../http/response.js';
import type { CharacterSpriteOutput, NarrativeOutput } from '../modules/sessions/service.js';
import { createServices, type Services } from '../services.js';
import { createUsecases } from '../usecases.js';
import { memoryCredentials } from '../testing/credentials.js';
import { narrativePreset } from '../testing/fixtures.js';
import { createSessionRoutes } from './sessions.js';

let db: DatabaseSync, root: string, services: Services, app: Hono;
let usecases: ReturnType<typeof createUsecases>, shutdown: AbortController;
let allowed: boolean;
const item = { position: 'left' as const, characterId: 'alice', spriteId: 'default' };

beforeEach(() => {
  db = openDatabase(':memory:');
  root = mkdtempSync(join(tmpdir(), 'sr-character-sprite-routes-'));
  services = createServices(db, root, memoryCredentials());
  const events = new EventHub();
  usecases = createUsecases({ services, events, transaction: bindTransaction(db) });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'ref' });
  // No current catalog: a historical result remains readable when an author removes a sprite.
  services.worlds.create({ id: 'world', specVersion: '0.2', publication: worldPublication(), name: 'World',
    characters: [{ id: 'player', name: 'Player', player_selectable: true }],
    openings: [{ id: 'opening', name: 'Opening', content: 'Begin' }] });
  for (const id of ['one', 'other']) services.sessions.create({
    id, worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player',
  });
  shutdown = new AbortController();
  allowed = true;
  app = new Hono().onError(errorHandler);
  app.route('/api/v1/sessions', createSessionRoutes({
    sessions: services.sessions, worlds: services.worlds, events,
    createSession: usecases.createSession,
    canAccessSession: () => allowed, shutdownSignal: shutdown.signal,
  }));
});
afterEach(async () => {
  shutdown.abort();
  await usecases.narrative.shutdown();
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function save(id: string, result?: CharacterSpriteOutput, sessionId = 'one') {
  const input = { id, runId: id, type: 'message' as const, role: 'assistant' as const,
    payload: { message: { role: 'assistant', content: 'Saved story', timestamp: 1 } } };
  const output: NarrativeOutput = {
    stateUpdate: { status: 'no_updates', updates: [] },
    actionSuggestions: { status: 'no_suggestions', items: [] },
    ...(result === undefined ? {} : { characterSprite: result }),
  };
  return services.sessions.appendNarrativeAssistant(sessionId, input, output);
}
const query = (id: string, sessionId = 'one') =>
  app.request('/api/v1/sessions/' + sessionId + '/entries/' + id + '/character-sprites');

async function result(id: string) {
  const response = await query(id);
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope).toMatchObject({ success: true, errorCode: null, errorMessage: '',
    data: { sessionId: 'one', messageId: id } });
  return envelope.data.result;
}
async function failure(id: string, code: string, status: number, sessionId = 'one') {
  const response = await query(id, sessionId);
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ success: false, errorCode: code, data: null });
}

describe('specified message character sprite query', () => {
  it('returns only the selected message and never inherits an earlier snapshot', async () => {
    save('with-sprites', { status: 'success', items: [item] });
    save('no-sprites');
    services.sessions.appendEntry('one', {
      id: 'user', runId: 'next', type: 'message', role: 'user', payload: { message: { role: 'user', content: 'Continue', timestamp: 1 } },
    });
    expect(await result('with-sprites')).toEqual({ status: 'success', items: [item] });
    expect(await result('no-sprites')).toBeNull();
    expect(await result('user')).toBeNull();
  });

  it('preserves partial success, explicit clearing and all-invalid statuses', async () => {
    const partial: CharacterSpriteOutput = { status: 'partial_success', items: [item],
      errors: [{ line: 2, errorCode: 'duplicate_position' }] };
    const invalid: CharacterSpriteOutput = { status: 'invalid_items', items: [],
      errors: [{ line: 1, errorCode: 'unknown_sprite' }] };
    save('partial', partial);
    save('clear', { status: 'success', items: [] });
    save('invalid', invalid);
    expect(await result('partial')).toEqual(partial);
    expect(await result('clear')).toEqual({ status: 'success', items: [] });
    expect(await result('invalid')).toEqual(invalid);
  });

  it('checks session access, exact ownership and message type', async () => {
    save('foreign', { status: 'success', items: [item] }, 'other');
    await failure('foreign', 'ENTRY_NOT_FOUND', 404);
    await failure('missing', 'ENTRY_NOT_FOUND', 404);
    await failure('missing', 'SESSION_NOT_FOUND', 404, 'missing-session');
    services.sessions.appendEntry('one', { id: 'summary', runId: 'summary-run',
      type: 'compaction', role: null, payload: { summary: 'Earlier story' } });
    await failure('summary', 'INVALID_REQUEST', 400);
    allowed = false;
    const read = vi.spyOn(services.sessions, 'getMessageCharacterSprites');
    await failure('summary', 'SESSION_NOT_FOUND', 404);
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps saved output through ordinary edits and rejects a caller-supplied replacement', async () => {
    const snapshot: CharacterSpriteOutput = { status: 'success', items: [item] };
    save('saved', snapshot);
    services.sessions.updateEntry('one', 'saved', { payload: { message: { role: 'assistant', content: 'Edited story', timestamp: 1 } }, extData: { note: 'changed' } });
    expect(await result('saved')).toEqual(snapshot);
    expect(() => services.sessions.updateEntry('one', 'saved', { extData: { output: {
      characterSprite: { status: 'success', items: [] },
    } } })).toThrow();
    services.sessions.deleteEntry('one', 'saved', 'saved');
    await failure('saved', 'ENTRY_NOT_FOUND', 404);
  });

  it('projects corrupt stored output as a failure without rewriting it or claiming a clear', async () => {
    save('corrupt', { status: 'success', items: [item] });
    const stored = JSON.stringify({ output: { characterSprite: {
      status: 'success', items: [item, { ...item, characterId: 'bob' }],
    } } });
    db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(stored, 'corrupt');
    expect(await result('corrupt')).toEqual({
      status: 'processing_error', items: [],
      errors: [{ errorCode: 'CHARACTER_SPRITE_STORED_RESULT_INVALID' }],
    });
    expect(db.prepare('SELECT ext_data FROM entries WHERE id=?').get('corrupt')?.ext_data).toBe(stored);
  });
});
