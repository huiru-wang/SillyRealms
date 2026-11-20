import type { EventHub } from './event-hub.js';

const HEARTBEAT_MS = 15_000;
const HIGH_WATER_MARK_BYTES = 256 * 1024;
const MAX_UNREAD_BYTES = 8 * 1024 * 1024;
type PendingFrame = { bytes: Uint8Array; offset: number; next?: PendingFrame };

/** The caller validates session access before opening this response. No replay. */
export function createSessionEventsResponse(
  hub: EventHub,
  sessionId: string,
  signal: AbortSignal,
  shutdown?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  let close = () => {};
  let flush = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal.aborted || shutdown?.aborted) {
        controller.close();
        return;
      }
      let closed = false, flushing = false;
      let unsubscribe = () => {};
      let first: PendingFrame | undefined, last: PendingFrame | undefined;
      let pendingBytes = 0;
      close = () => {
        if (closed) return;
        closed = true;
        first = last = undefined;
        pendingBytes = 0;
        unsubscribe();
        clearInterval(timer);
        signal.removeEventListener('abort', close);
        shutdown?.removeEventListener('abort', close);
        try { controller.close(); } catch { /* The response body may already be cancelled. */ }
      };
      flush = () => {
        if (closed || flushing) return;
        flushing = true;
        try {
          while (first) {
            const capacity = controller.desiredSize ?? 0;
            if (capacity <= 0) return;
            const length = Math.min(first.bytes.byteLength - first.offset, capacity);
            controller.enqueue(first.bytes.subarray(first.offset, first.offset + length));
            first.offset += length;
            pendingBytes -= length;
            if (first.offset === first.bytes.byteLength) {
              first = first.next;
              if (!first) last = undefined;
            }
          }
        } catch { close(); }
        finally { flushing = false; }
      };
      const send = (text: string) => {
        if (closed) return;
        const bytes = encoder.encode(text);
        const enqueuedBytes = HIGH_WATER_MARK_BYTES - (controller.desiredSize ?? 0);
        // One bounded backlog includes both pending frames and controller-owned bytes.
        if (bytes.byteLength > MAX_UNREAD_BYTES - pendingBytes - enqueuedBytes) {
          close();
          return;
        }
        const frame: PendingFrame = { bytes, offset: 0 };
        if (last) last.next = frame;
        else first = frame;
        last = frame;
        pendingBytes += bytes.byteLength;
        // A frame may span transport chunks; its SSE event/data bytes stay unchanged.
        flush();
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
    pull() { flush(); },
    cancel() { close(); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER_MARK_BYTES }));

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
