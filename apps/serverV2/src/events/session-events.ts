import type { EventHub } from './event-hub.js';

const HEARTBEAT_MS = 15_000;
const MAX_QUEUED_BYTES = 256 * 1024;

/** The caller validates session access before opening this response. No replay. */
export function createSessionEventsResponse(
  hub: EventHub,
  sessionId: string,
  signal: AbortSignal,
  shutdown?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal.aborted || shutdown?.aborted) {
        controller.close();
        return;
      }
      let closed = false;
      let unsubscribe = () => {};
      close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(timer);
        signal.removeEventListener('abort', close);
        shutdown?.removeEventListener('abort', close);
        try { controller.close(); } catch { /* The response body may already be cancelled. */ }
      };
      const send = (text: string) => {
        if (closed) return;
        const bytes = encoder.encode(text);
        // Bound each connection independently, including oversized single events.
        if (bytes.byteLength > (controller.desiredSize ?? 0)) {
          close();
          return;
        }
        try { controller.enqueue(bytes); } catch { close(); }
      };
      const timer = setInterval(() => send(': heartbeat\n\n'), HEARTBEAT_MS);
      unsubscribe = hub.subscribe(sessionId, ({ event, data }) => {
        try {
          if (!event || /[\r\n\0]/u.test(event)) throw new Error('Invalid SSE event name');
          send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch { close(); }
      });
      signal.addEventListener('abort', close, { once: true });
      shutdown?.addEventListener('abort', close, { once: true });
      send(': connected\n\n');
    },
    cancel() { close(); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_QUEUED_BYTES }));

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
