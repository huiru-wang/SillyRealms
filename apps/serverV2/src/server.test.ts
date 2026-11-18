import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventHub } from './events/event-hub.js';
import { startServer } from './server.js';

type RunningServer = Awaited<ReturnType<typeof startServer>>;
const servers: RunningServer[] = [];
const clients: AbortController[] = [];

async function launch(options: Parameters<typeof startServer>[0] = {}) {
  const running = await startServer({ ...options, port: 0 });
  servers.push(running);
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
});

describe('Server V2 over HTTP', () => {
  it('starts without storage and reports unavailable access checks instead of accepting fake sessions', async () => {
    const { url } = await launch();
    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    const events = await fetch(`${url}/api/v1/sessions/anything/events`);
    expect(events.status).toBe(503);
    expect(await events.json()).toEqual({ errorCode: 'SESSION_ACCESS_UNAVAILABLE' });
    const publish = await fetch(`${url}/api/v1/sessions/anything/events`, { method: 'POST' });
    expect(publish.status).toBe(404);
    await publish.body?.cancel();
  });

  it('checks existence and access before subscribing, without exposing internal errors', async () => {
    const events = new EventHub();
    const subscribe = vi.spyOn(events, 'subscribe');
    const { url } = await launch({ events, canAccessSession: async (id, request) => {
      if (id === 'broken') throw new Error('private storage detail');
      return id === 'allowed' && request.headers.get('x-test-access') === 'yes';
    } });
    for (const id of ['missing', 'allowed']) {
      const response = await fetch(`${url}/api/v1/sessions/${id}/events`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ errorCode: 'SESSION_NOT_FOUND' });
    }
    const broken = await fetch(`${url}/api/v1/sessions/broken/events`);
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ errorCode: 'INTERNAL_ERROR' });
    expect(subscribe).not.toHaveBeenCalled();
    const allowed = await fetch(`${url}/api/v1/sessions/allowed/events`, { headers: { 'x-test-access': 'yes' } });
    expect(allowed.status).toBe(200);
    expect(subscribe).toHaveBeenCalledOnce();
    await allowed.body?.cancel();
  });

  it('pushes multiple runs and late events through the same connection and isolates sessions', async () => {
    const sessions = new Set(['a', 'b']);
    const { url, events } = await launch({ canAccessSession: id => sessions.has(id) });
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
    const { url } = await launch({ events, canAccessSession: id => id === 'a' });
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
    const running = await launch({ canAccessSession: () => true });
    const first = await connect(running.url, 'a'), second = await connect(running.url, 'b');
    const closing = running.close();
    expect(running.close()).toBe(closing);
    expect(await first.readFrame()).toBeUndefined();
    expect(await second.readFrame()).toBeUndefined();
    await closing;
    expect(running.server.listening).toBe(false);
  });

  it('does not open a new stream if shutdown happens during the access check', async () => {
    let allow!: (value: boolean) => void;
    const pendingAccess = new Promise<boolean>(resolve => { allow = resolve; });
    const canAccessSession = vi.fn(() => pendingAccess);
    const running = await launch({ canAccessSession });
    const request = fetch(`${running.url}/api/v1/sessions/a/events`);
    await vi.waitFor(() => expect(canAccessSession).toHaveBeenCalledOnce());
    const closing = running.close();
    allow(true);
    const response = await request;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ errorCode: 'SERVER_SHUTTING_DOWN' });
    await closing;
  });

  it('runs the CLI entry and exits cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./server.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, SERVER_V2_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    try {
      await vi.waitFor(() => expect(output, errors).toMatch(/Server V2: http:\/\/127\.0\.0\.1:\d+/u), { timeout: 2500 });
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/u)![0];
      const health = await fetch(`${url}/health`);
      expect(await health.json()).toEqual({ ok: true });
      child.kill('SIGTERM');
      expect(await exited).toEqual([0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
