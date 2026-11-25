import type {
  AcceptedRun, RegenerateRequest, RunPage, RunQuery, SessionEvent, StageCommand, StageSnapshot,
  StateChangedEvent, StateScope, StateSnapshot, StateValue, StateWrite, StateWriteResult,
} from '../stage-contract.js';

export interface SRSessionAPI {
  setDraft(text: string): Promise<void>;
  send(text: string): Promise<AcceptedRun>;
  regenerate(input: RegenerateRequest): Promise<AcceptedRun>;
  stop(runId: string, assistantEntryId: string): Promise<{runId: string; assistantEntryId: string; stopping: true}>;
  /** Server returns items/entries; querying never changes the displayed history. */
  getRuns(options?: RunQuery): Promise<RunPage>;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}
export interface SRStateAPI {
  getState(path: string, scope?: StateScope): Promise<StateValue | undefined>;
  batchGetState(entries: Array<{path: string; scope?: StateScope}>): Promise<Array<{
    path: string; scope: StateScope; value: StateValue | undefined;
  }>>;
  updateState(path: string, value: StateValue, scope?: StateScope): Promise<StateWriteResult[]>;
  batchUpdateState(entries: StateWrite[]): Promise<StateWriteResult[]>;
  subscribe(listener: (event: StateChangedEvent) => void): () => void;
}

export function emptyStageSnapshot(): StageSnapshot {
  return {
    sessionId: '', connected: false, activeRunId: null, activeAssistantEntryId: null, sending: false, runs: [], suggestions: {items: []},
    history: {loading: true, loadingMore: false, hasMore: false, error: null},
    state: {global: {}, session: {}, message: {}}, stateLoading: true, stateError: null,
  };
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Scope snapshots are already normalized by the Host. Only own object keys are readable. */
export function stateValue(snapshot: StateSnapshot, scope: StateScope, path: string): StateValue | undefined {
  if (typeof path !== 'string' || !path || !Object.hasOwn(snapshot, scope)) return undefined;
  let value: StateValue | undefined = snapshot[scope];
  for (const key of path.split('.')) {
    if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor' ||
        value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/** The frame owns a display mirror only. Commands and raw events never reduce business state. */
export class StageRuntime {
  private snapshot = freeze(emptyStageSnapshot());
  private readonly observers = new Set<() => void>();
  private readonly listeners = new Set<(event: SessionEvent) => void>();
  readonly session: SRSessionAPI;
  readonly state: SRStateAPI;
  readonly history: {
    loadMore(): Promise<void>;
    refresh(): Promise<void>;
    query(options?: RunQuery): Promise<RunPage>;
  };

  constructor(command: StageCommand) {
    const subscribe = (listener: (event: SessionEvent) => void) => {
      this.listeners.add(listener);
      return () => { this.listeners.delete(listener); };
    };
    this.session = Object.freeze({
      setDraft: (text: string) => command('composer.setDraft', {text}),
      send: (text: string) => command('narrative.send', {text}),
      regenerate: (input: RegenerateRequest) => command('narrative.regenerate', input),
      stop: (runId: string, assistantEntryId: string) => command('narrative.stop', {runId, assistantEntryId}),
      getRuns: (options: RunQuery = {}) => command('history.query', options),
      subscribe,
    });
    const write = (updates: StateWrite[]) => command('state.write', {updates});
    this.state = Object.freeze({
      getState: async (path: string, scope: StateScope = 'message') =>
        structuredClone(stateValue(await command('state.read', {}), scope, path)),
      batchGetState: async (entries: Array<{path: string; scope?: StateScope}>) => {
        const snapshot = await command('state.read', {});
        return entries.map(entry => ({
          path: entry.path, scope: entry.scope ?? 'message',
          value: structuredClone(stateValue(snapshot, entry.scope ?? 'message', entry.path)),
        }));
      },
      updateState: (path: string, value: StateValue, scope: StateScope = 'message') => write([{path, value, scope}]),
      batchUpdateState: (entries: StateWrite[]) => write(entries.map(entry => ({...entry, scope: entry.scope ?? 'message'}))),
      subscribe: (listener: (event: StateChangedEvent) => void) => subscribe(event => {
        if (event.event === 'state.changed') listener(event);
      }),
    });
    this.history = Object.freeze({
      loadMore: () => command('history.loadMore', {}),
      refresh: () => command('history.refresh', {}),
      query: (options: RunQuery = {}) => command('history.query', options),
    });
  }

  getSnapshot = (): StageSnapshot => this.snapshot;
  observe = (listener: () => void): (() => void) => {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  };

  acceptSnapshot(snapshot: StageSnapshot): void {
    this.snapshot = freeze(structuredClone(snapshot));
    for (const listener of [...this.observers]) {
      try { listener(); } catch { /* One author hook cannot block another subscriber. */ }
    }
  }

  acceptEvent(event: SessionEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(structuredClone(event)); } catch { /* Author subscribers are isolated. */ }
    }
  }

  reset(): void { this.acceptSnapshot(emptyStageSnapshot()); }
}
