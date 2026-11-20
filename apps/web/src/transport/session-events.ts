import type {SessionEvent} from '../../../../packages/sr-sdk/src/stage-contract.ts';

/** Explicit Server names: EventSource has no wildcard event listener. */
export const SESSION_EVENT_NAMES = [
  'session.created', 'run.created', 'run.summarizing', 'run.summarized',
  'run.delta', 'run.usage', 'run.completed', 'run.stopped',
  'state.changed', 'action_suggestions.created',
] as const;
export type SessionEventNamespace = 'session' | 'run' | 'state' | 'action_suggestions' | '*';
export type SessionConnection = {
  sessionId: string;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
  connected: boolean;
  /** Increases on each successful open, including EventSource reconnects. */
  generation: number;
};
export type EventSourcePort = {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
};
type Options = {
  sessionId: string;
  createSource?: (url: string) => EventSourcePort;
  url?: string;
};

function wireEvent(name: typeof SESSION_EVENT_NAMES[number], value: unknown, sessionId: string): SessionEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (name === 'state.changed') {
    if (!['global', 'session', 'message'].includes(String(data.scope)) || typeof data.path !== 'string' || !Object.hasOwn(data, 'value')) return null;
  } else {
    if (data.sessionId !== sessionId) return null;
    if (name.startsWith('run.') || name === 'action_suggestions.created') {
      if (typeof data.runId !== 'string' || !data.runId) return null;
    }
    if (name === 'run.created' && (!Array.isArray(data.messages) || data.messages.length !== 1)) return null;
    if (name === 'run.delta' && (typeof data.messageId !== 'string' || !Array.isArray(data.messages) || data.messages.length !== 1)) return null;
    if (name === 'action_suggestions.created' && (typeof data.messageId !== 'string' || !Array.isArray(data.items))) return null;
    if ((name === 'run.completed' || name === 'run.stopped') &&
      (!Array.isArray(data.savedMessageIds) || !(data.tipEntryId === null || typeof data.tipEntryId === 'string'))) return null;
  }
  return {event: name, data} as SessionEvent;
}

/** One connection for the session. It never owns domain caches or stops a run. */
export function createSessionEventChannel(options: Options) {
  let source: EventSourcePort | null = null, disposed = false;
  let snapshot: SessionConnection = {sessionId: options.sessionId, status: 'idle', connected: false, generation: 0};
  const listeners = new Map<SessionEventNamespace, Set<(event: SessionEvent) => void>>();
  const connections = new Set<(connection: SessionConnection) => void>();
  const notifyConnection = (status: SessionConnection['status']) => {
    snapshot = {...snapshot, status, connected: status === 'connected',
      generation: snapshot.generation + (status === 'connected' ? 1 : 0)};
    for (const listener of connections) try { listener({...snapshot}); } catch { /* Isolate consumers. */ }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(namespace: SessionEventNamespace, listener: (event: SessionEvent) => void) {
      const group = listeners.get(namespace) ?? new Set();
      group.add(listener); listeners.set(namespace, group);
      return () => { group.delete(listener); };
    },
    subscribeConnection(listener: (connection: SessionConnection) => void) {
      connections.add(listener);
      try { listener({...snapshot}); } catch { /* Isolate consumers. */ }
      return () => { connections.delete(listener); };
    },
    connect() {
      if (disposed || source) return;
      notifyConnection('connecting');
      const opened = (options.createSource ?? (url => new EventSource(url)))(
        options.url ?? '/api/v1/sessions/' + encodeURIComponent(options.sessionId) + '/events');
      source = opened;
      const current = () => !disposed && source === opened;
      opened.addEventListener('open', () => { if (current()) notifyConnection('connected'); });
      opened.addEventListener('error', () => { if (current()) notifyConnection('reconnecting'); });
      for (const name of SESSION_EVENT_NAMES) opened.addEventListener(name, event => {
        if (!current()) return;
        let parsed: SessionEvent | null;
        try { parsed = wireEvent(name, JSON.parse(event.data), options.sessionId); } catch { return; }
        if (!parsed) return;
        const namespace = name.slice(0, name.indexOf('.')) as SessionEventNamespace;
        for (const listener of new Set([...(listeners.get(namespace) ?? []), ...(listeners.get('*') ?? [])])) {
          try { listener(structuredClone(parsed)); } catch { /* A broken consumer cannot stop other domains. */ }
        }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; source?.close(); source = null;
      notifyConnection('closed');
      listeners.clear(); connections.clear();
    },
  };
}
export type SessionEventChannel = ReturnType<typeof createSessionEventChannel>;
