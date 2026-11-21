import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { EventHub } from './infrastructure/events/event-hub.js';
import type { Services } from './services.js';
import { narrativePreset } from './testing/fixtures.js';
import { startServer } from './server.js';

type RunningServer = Awaited<ReturnType<typeof startServer>>;
const servers: RunningServer[] = [];
const clients: AbortController[] = [];
const directories: string[] = [];
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'sr-v2-server-'));
  directories.push(directory);
  return directory;
}

function seedSessions(services: Services, ids: string[]) {
  const preset = services.presets.create(narrativePreset());
  const model = services.models.create({ name: 'Test model', providerId: 'test', modelId: 'test-model', credentialRef: 'test-ref' });
  const world = services.worlds.create({ name: 'Test world', specVersion: '0.1', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });
  for (const id of ids) services.sessions.create({
    id, worldId: world.id, presetId: preset.id, apiModelConfigId: model.id, userCharacterId: 'player',
  });
}

async function launch(options: Parameters<typeof startServer>[0] = {}, sessionIds: string[] = []) {
  const running = await startServer({ databasePath: ':memory:', ...options, port: 0 });
  servers.push(running);
  if (sessionIds.length) seedSessions(running.services, sessionIds);
  const address = running.server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  return { ...running, url: `http://127.0.0.1:${address.port}` };
}

async function connect(url: string, sessionId: string) {
  const controller = new AbortController();
  clients.push(controller);
  const response = await fetch(`${url}/api/v1/sessions/${sessionId}/events`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]),
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  async function readFrame(): Promise<string | undefined> {
    while (!buffered.includes('\n\n')) {
      const { done, value } = await reader.read();
      if (done) return undefined;
      buffered += decoder.decode(value, { stream: true });
    }
    const end = buffered.indexOf('\n\n') + 2;
    const frame = buffered.slice(0, end);
    buffered = buffered.slice(end);
    return frame;
  }
  expect(await readFrame()).toBe(': connected\n\n');
  return { controller, readFrame };
}

afterEach(async () => {
  for (const controller of clients.splice(0)) controller.abort();
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Server over HTTP', () => {
  it('requires the business Services even when a custom access check permits a request', async () => {
    const app = createApp({ events: new EventHub(), canAccessSession: () => true });
    const response = await app.request('/api/v1/sessions/anything/events');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, errorCode: 'SERVICE_UNAVAILABLE', errorMessage: '业务服务尚未就绪', data: null });
    await app.shutdown();
  });

  it('opens independent storage and rejects missing sessions instead of accepting fake sessions', async () => {
    const { url } = await launch({ canAccessSession: () => true });
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ success: true, errorCode: null, errorMessage: '', data: { ok: true } });
    const events = await fetch(`${url}/api/v1/sessions/anything/events`);
    expect(events.status).toBe(404);
    expect(await events.json()).toEqual({ success: false, errorCode: 'SESSION_NOT_FOUND', errorMessage: '会话不存在', data: null });
    const publish = await fetch(`${url}/api/v1/sessions/anything/events`, { method: 'POST' });
    expect(publish.status).toBe(404);
    await publish.body?.cancel();
  });

  it('uses persisted sessions after reopening and releases its database when HTTP closes', async () => {
    const dataRoot = temporaryDirectory(), databasePath = join(dataRoot, 'database.sqlite');
    const running = await launch({ dataRoot, databasePath });
    const model = running.services.models.create({
      name: 'Local model', providerId: 'provider', modelId: 'actual-model', credentialRef: 'test-ref',
    });
    const preset = running.services.presets.create(narrativePreset());
    running.services.settings.update({ defaultPresetId: preset.id, defaultApiModelConfigId: model.id });
    const world = running.services.worlds.create({
      name: 'Persistent world', specVersion: '0.1', characters: [{ id: 'player', name: 'Player', player_selectable: true }],
      openings: [{ id: 'start', name: 'Start', content: 'Begin' }], tags: ['test'], defaultPresetId: preset.id, defaultApiModelConfigId: model.id,
    });
    const session = running.services.sessions.create({
      worldId: world.id, presetId: preset.id, apiModelConfigId: model.id, userCharacterId: 'player',
    });
    const entry = running.services.sessions.appendEntry(session.id, {
      runId: 'run-1', type: 'message', role: 'assistant', payload: { text: 'Saved story' }, state: [],
    });
    running.usecases.setState.setSession(session.id, { gold: 12 });
    const stream = await connect(running.url, session.id);
    running.events.publish(session.id, { event: 'storage.ready', data: { entryId: entry.id } });
    expect(await stream.readFrame()).toContain(entry.id);
    await running.close();
    expect(() => running.services.sessions.get(session.id)).toThrow();

    const reopened = await launch({ dataRoot, databasePath });
    expect(reopened.services.sessions.getHistory(session.id).map(item => item.id)).toEqual([entry.id]);
    expect(reopened.services.state.getSession(session.id)).toEqual({ gold: 12 });
    expect(reopened.services.worlds.get(world.id)?.tags).toEqual(['test']);
    expect(reopened.services.settings.get().defaultPresetId).toBe(preset.id);
    const restored = await connect(reopened.url, session.id);
    reopened.events.publish(session.id, { event: 'after.restart', data: {} });
    expect(await restored.readFrame()).toContain('after.restart');
  });

  it('releases storage if the HTTP listener cannot start', async () => {
    const running = await launch();
    const address = running.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    await expect(startServer({ port: address.port, databasePath: ':memory:' })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('checks existence and access before subscribing, without exposing internal errors', async () => {
    const events = new EventHub();
    const subscribe = vi.spyOn(events, 'subscribe');
    const { url } = await launch({ events, canAccessSession: async (id, request) => {
      if (id === 'broken') throw new Error('private storage detail');
      return id === 'allowed' && request.headers.get('x-test-access') === 'yes';
    } }, ['allowed', 'broken']);
    for (const id of ['missing', 'allowed']) {
      const response = await fetch(`${url}/api/v1/sessions/${id}/events`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ success: false, errorCode: 'SESSION_NOT_FOUND', errorMessage: '会话不存在', data: null });
    }
    const broken = await fetch(`${url}/api/v1/sessions/broken/events`);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ success: false, errorCode: 'INTERNAL_ERROR', errorMessage: '服务内部错误', data: null });
    expect(subscribe).not.toHaveBeenCalled();
    const allowed = await fetch(`${url}/api/v1/sessions/allowed/events`, { headers: { 'x-test-access': 'yes' } });
    expect(allowed.status).toBe(200);
    expect(subscribe).toHaveBeenCalledOnce();
    await allowed.body?.cancel();
  });

  it('pushes multiple runs and late events through the same connection and isolates sessions', async () => {
    const sessions = new Set(['a', 'b']);
    const { url, events } = await launch({ canAccessSession: id => sessions.has(id) }, ['a', 'b']);
    const first = await connect(url, 'a');
    const sibling = await connect(url, 'a');
    const other = await connect(url, 'b');
    for (const [index, terminal] of ['completed', 'failed', 'stopped'].entries()) {
      for (const event of ['run.created', 'run.delta', `run.${terminal}`, 'custom.result']) {
        const data = { runId: String(index), text: '正文\n后续内容' };
        events.publish('a', { event, data });
        const expected = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        expect(await first.readFrame()).toBe(expected);
        expect(await sibling.readFrame()).toBe(expected);
      }
    }
    events.publish('b', { event: 'own.result', data: {} });
    expect(await other.readFrame()).toBe('event: own.result\ndata: {}\n\n');
  });

  it('cleans up an aborted HTTP connection and reconnects without replay', async () => {
    const events = new EventHub();
    const originalSubscribe = events.subscribe.bind(events);
    const cleanups: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(events, 'subscribe').mockImplementation((id, listener) => {
      const cleanup = vi.fn(originalSubscribe(id, listener));
      cleanups.push(cleanup);
      return cleanup;
    });
    const { url } = await launch({ events, canAccessSession: id => id === 'a' }, ['a']);
    const first = await connect(url, 'a'), sibling = await connect(url, 'a');
    first.controller.abort();
    await vi.waitFor(() => expect(cleanups[0]).toHaveBeenCalledOnce());
    expect(cleanups[1]).not.toHaveBeenCalled();
    events.publish('a', { event: 'during.disconnect', data: {} });
    expect(await sibling.readFrame()).toContain('during.disconnect');
    const reconnected = await connect(url, 'a');
    events.publish('a', { event: 'new', data: {} });
    expect(await reconnected.readFrame()).toBe('event: new\ndata: {}\n\n');
    expect(await sibling.readFrame()).toBe('event: new\ndata: {}\n\n');
  });

  it('ends open SSE streams and stops listening on shutdown, including repeated close calls', async () => {
    const running = await launch({ canAccessSession: () => true }, ['a', 'b']);
    const first = await connect(running.url, 'a'), second = await connect(running.url, 'b');
    const closing = running.close();
    expect(running.close()).toBe(closing);
    expect(await first.readFrame()).toBeUndefined();
    expect(await second.readFrame()).toBeUndefined();
    await closing;
    expect(running.server.listening).toBe(false);
  });

  it('does not subscribe when a session is deleted during the access check', async () => {
    let allow!: (value: boolean) => void;
    const pendingAccess = new Promise<boolean>(resolve => { allow = resolve; });
    const canAccessSession = vi.fn(() => pendingAccess);
    const running = await launch({ canAccessSession }, ['a']);
    const subscribe = vi.spyOn(running.events, 'subscribe');
    const request = fetch(`${running.url}/api/v1/sessions/a/events`);
    await vi.waitFor(() => expect(canAccessSession).toHaveBeenCalledOnce());
    running.services.sessions.delete('a');
    allow(true);
    const response = await request;
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, errorCode: 'SESSION_NOT_FOUND', errorMessage: '会话不存在', data: null });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('does not open a new stream if shutdown happens during the access check', async () => {
    let allow!: (value: boolean) => void;
    const pendingAccess = new Promise<boolean>(resolve => { allow = resolve; });
    const canAccessSession = vi.fn(() => pendingAccess);
    const running = await launch({ canAccessSession }, ['a']);
    const request = fetch(`${running.url}/api/v1/sessions/a/events`);
    await vi.waitFor(() => expect(canAccessSession).toHaveBeenCalledOnce());
    const closing = running.close();
    allow(true);
    const response = await request;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, errorCode: 'SERVER_SHUTTING_DOWN', errorMessage: '服务正在关闭', data: null });
    await closing;
  });

  it('runs the CLI entry and exits cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./server.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, SERVER_PORT: '0', SERVER_DATA_ROOT: temporaryDirectory() },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    try {
      await vi.waitFor(() => expect(output, errors).toMatch(/Server: http:\/\/127\.0\.0\.1:\d+/u), { timeout: 4000 });
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/u)![0];
      const health = await fetch(`${url}/health`);
      expect(await health.json()).toEqual({ success: true, errorCode: null, errorMessage: '', data: { ok: true } });
      child.kill('SIGTERM');
      expect(await exited).toEqual([0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
