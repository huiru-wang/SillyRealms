/** State values crossing the creator iframe boundary are JSON values. */
export type StateScope = 'global' | 'session' | 'message';
export type StateValue = null | boolean | number | string | StateValue[] | { [key: string]: StateValue };

export type StateEvent = {
  event: 'state.changed';
  data: { path: string; scope: StateScope; value: StateValue };
};

/** Each SDK write has its own transaction and field-level failure, matching the HTTP contract. */
export type StateWriteResult = {
  path: string;
  scope: StateScope;
  stateScope?: StateScope;
  statePath?: string;
  rulePath?: string;
} & (
  { success: true; errorCode: null; errorMessage: '' } |
  { success: false; errorCode: string; errorMessage: string }
);

export interface SRStateAPI {
  getState(path: string, scope?: StateScope): Promise<StateValue | undefined>;
  batchGetState(entries: Array<{ path: string; scope?: StateScope }>): Promise<Array<{
    path: string;
    scope: StateScope;
    value: StateValue | undefined;
  }>>;
  updateState(path: string, value: StateValue, scope?: StateScope): Promise<StateWriteResult[]>;
  batchUpdateState(entries: Array<{ path: string; value: StateValue; scope?: StateScope }>): Promise<StateWriteResult[]>;
  subscribe(listener: (event: StateEvent) => void): () => void;
}
