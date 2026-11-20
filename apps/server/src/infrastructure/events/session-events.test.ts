import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventHub } from './event-hub.js';
import { createSessionEventsResponse } from './session-events.js';

const decoder = new TextDecoder();
type Reader = ReadableStreamDefaultReader<Uint8Array>;
async function readText(reader: Reader): Promise<string> {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  return decoder.decode(chunk.value);
}

async function readFrame(reader: Reader): Promise<string> {
  const decoder = new TextDecoder();
  let frame = '';
  while (!frame.endsWith('\n\n')) {
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(chunk.value!.byteLength).toBeLessThanOrEqual(256 * 1024);
    frame += decoder.decode(chunk.value, { stream: true });
  }
  return frame + decoder.decode();
}
async function drainClosed(reader: Reader): Promise<number> {
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return bytes;
    bytes += chunk.value.byteLength;
  }
}

describe('session SSE', () => {
  const connections: AbortController[] = [];
  function connect(hub: EventHub, sessionId = 'session', shutdown?: AbortSignal) {
    const controller = new AbortController();
    connections.push(controller);
    const response = createSessionEventsResponse(hub, sessionId, controller.signal, shutdown);
    return { response, reader: response.body!.getReader(), controller };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    for (const controller of connections.splice(0)) controller.abort();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps one connection across completed, failed and stopped runs and forwards late events', async () => {
    const hub = new EventHub();
    const { response, reader } = connect(hub);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(await readText(reader)).toBe(': connected\n\n');
    for (const [index, status] of ['completed', 'failed', 'stopped'].entries()) {
      const runId = String(index);
      for (const event of ['run.created', 'run.delta', `run.${status}`, 'custom.result']) {
        const data = { runId, text: '正文\n下一行', nested: { score: 12 } };
        hub.publish('session', { event, data });
        expect(await readText(reader)).toBe(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }
    vi.advanceTimersByTime(15_000);
    expect(await readText(reader)).toBe(': heartbeat\n\n');
  });

  it('sends the same event to every connection of the session', async () => {
    const hub = new EventHub();
    const first = connect(hub), second = connect(hub);
    await readText(first.reader); await readText(second.reader);
    hub.publish('session', { event: 'result', data: {} });
    const frame = 'event: result\ndata: {}\n\n';
    expect(await readText(first.reader)).toBe(frame);
    expect(await readText(second.reader)).toBe(frame);
  });

  it('keeps sibling connections alive when a client disconnects and isolates sessions', async () => {
    const hub = new EventHub();
    const first = connect(hub), sibling = connect(hub), other = connect(hub, 'other');
    for (const connection of [first, sibling, other]) await readText(connection.reader);
    await first.reader.cancel();
    hub.publish('session', { event: 'result', data: { id: 1 } });
    expect(await readText(sibling.reader)).toContain('"id":1');
    hub.publish('other', { event: 'result', data: { id: 2 } });
    expect(await readText(other.reader)).toContain('"id":2');
    expect(await first.reader.read()).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(2);
  });

  it('removes subscriptions and abort listeners exactly once on request disconnect', async () => {
    const hub = new EventHub();
    const originalSubscribe = hub.subscribe.bind(hub);
    const unsubscribe = vi.fn();
    vi.spyOn(hub, 'subscribe').mockImplementation((sessionId, listener) => {
      const dispose = originalSubscribe(sessionId, listener);
      return () => { unsubscribe(); dispose(); };
    });
    const shutdown = new AbortController();
    const shutdownCleanup = vi.spyOn(shutdown.signal, 'removeEventListener');
    const { reader, controller } = connect(hub, 'session', shutdown.signal);
    const requestCleanup = vi.spyOn(controller.signal, 'removeEventListener');
    await readText(reader);
    const pending = reader.read();
    controller.abort();
    expect(await pending).toEqual({ done: true, value: undefined });
    shutdown.abort();
    await reader.cancel();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(requestCleanup).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(shutdownCleanup).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes all attached connections on server shutdown', async () => {
    const hub = new EventHub(), shutdown = new AbortController();
    const first = connect(hub, 'a', shutdown.signal), second = connect(hub, 'b', shutdown.signal);
    await readText(first.reader); await readText(second.reader);
    shutdown.abort();
    expect((await first.reader.read()).done).toBe(true);
    expect((await second.reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['request', 'shutdown'])('does not subscribe when %s is already aborted', async source => {
    const hub = new EventHub(), request = new AbortController(), shutdown = new AbortController();
    const subscribe = vi.spyOn(hub, 'subscribe');
    (source === 'request' ? request : shutdown).abort();
    const response = createSessionEventsResponse(hub, 'session', request.signal, shutdown.signal);
    expect(await response.text()).toBe('');
    expect(subscribe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reconnects for new events without replaying the disconnected interval', async () => {
    const hub = new EventHub();
    const first = connect(hub);
    await readText(first.reader);
    first.controller.abort();
    hub.publish('session', { event: 'missed', data: {} });
    const second = connect(hub);
    expect(await readText(second.reader)).toBe(': connected\n\n');
    hub.publish('session', { event: 'new', data: {} });
    expect(await readText(second.reader)).toBe('event: new\ndata: {}\n\n');
  });

  it('delivers a large UTF-8 snapshot followed by usage and completion without closing the session', async () => {
    const hub = new EventHub();
    const { reader } = connect(hub);
    await readText(reader);
    const snapshot = { runId: 'run', messageId: 'assistant', messages: [{
      role: 'assistant', content: '字'.repeat(100_000), reasoning_content: '推理'.repeat(15_000), tool_calls: [],
    }] };
    const usage = { runId: 'run', usage: null };
    const completed = { runId: 'run', assistantEntryId: 'assistant' };
    // Queue these synchronously, as narrative settlement does, before the reader catches up.
    hub.publish('session', { event: 'run.delta', data: snapshot });
    hub.publish('session', { event: 'run.usage', data: usage });
    hub.publish('session', { event: 'run.completed', data: completed });
    expect(await readFrame(reader)).toBe(`event: run.delta\ndata: ${JSON.stringify(snapshot)}\n\n`);
    expect(await readFrame(reader)).toBe(`event: run.usage\ndata: ${JSON.stringify(usage)}\n\n`);
    expect(await readFrame(reader)).toBe(`event: run.completed\ndata: ${JSON.stringify(completed)}\n\n`);
    vi.advanceTimersByTime(15_000);
    expect(await readText(reader)).toBe(': heartbeat\n\n');
  });

  it('counts controller bytes in the slow consumer budget and releases its pending frames without blocking a healthy connection', async () => {
    const hub = new EventHub();
    const slow = connect(hub), healthy = connect(hub);
    await readText(slow.reader); await readText(healthy.reader);
    for (let index = 0; index < 8; index++) {
      hub.publish('session', { event: 'chunk', data: { index, text: 'x'.repeat(1024 * 1024) } });
      expect(await readFrame(healthy.reader)).toContain(`"index":${index}`);
    }
    // Eight 1 MiB bodies plus framing exceed the combined 8 MiB unread budget.
    // Closing discards pending frames; only the bounded controller queue can still drain.
    expect(await drainClosed(slow.reader)).toBe(256 * 1024);
    hub.publish('session', { event: 'still.connected', data: {} });
    expect(await readText(healthy.reader)).toContain('still.connected');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('bounds oversized single events by the 8 MiB UTF-8 budget', async () => {
    const hub = new EventHub();
    const { reader } = connect(hub);
    await readText(reader);
    const waiting = reader.read();
    hub.publish('session', { event: 'large', data: { text: '字'.repeat(3 * 1024 * 1024) } });
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['request', 'shutdown', 'cancel'])('discards pending frame slices and removes the subscription on %s', async source => {
    const hub = new EventHub(), shutdown = new AbortController();
    const originalSubscribe = hub.subscribe.bind(hub), unsubscribe = vi.fn();
    vi.spyOn(hub, 'subscribe').mockImplementation((sessionId, listener) => {
      const dispose = originalSubscribe(sessionId, listener);
      return () => { unsubscribe(); dispose(); };
    });
    const { reader, controller } = connect(hub, 'session', shutdown.signal);
    await readText(reader);
    hub.publish('session', { event: 'large', data: { text: 'x'.repeat(1024 * 1024) } });
    if (source === 'cancel') await reader.cancel();
    else (source === 'request' ? controller : shutdown).abort();
    expect(await drainClosed(reader)).toBe(source === 'cancel' ? 0 : 256 * 1024);
    controller.abort(); shutdown.abort();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes an unencodable stream without throwing into the publisher', async () => {
    const hub = new EventHub();
    const { reader } = connect(hub);
    await readText(reader);
    const data: Record<string, unknown> = {};
    data.circular = data;
    expect(() => hub.publish('session', { event: 'result', data })).not.toThrow();
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not allow event names to inject SSE fields', async () => {
    const hub = new EventHub();
    const { reader } = connect(hub);
    await readText(reader);
    hub.publish('session', { event: 'result\ndata: injected', data: {} });
    expect((await reader.read()).done).toBe(true);
  });
});
