export type SessionEvent = {
  event: string;
  data: Record<string, unknown>;
};

type Listener = (event: SessionEvent) => void;

/** Synchronous, session-scoped delivery; subscribers never own business execution. */
export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    let listeners = this.listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionId, listeners);
    }
    // Each subscription owns its removal, including repeated use of one callback.
    const subscription: Listener = event => listener(event);
    listeners.add(subscription);
    return () => {
      listeners.delete(subscription);
      if (listeners.size === 0 && this.listeners.get(sessionId) === listeners) {
        this.listeners.delete(sessionId);
      }
    };
  }

  publish(sessionId: string, event: SessionEvent): void {
    const listeners = this.listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try { listener(event); }
      catch { /* One subscriber cannot interrupt the publisher or its siblings. */ }
    }
  }
}
