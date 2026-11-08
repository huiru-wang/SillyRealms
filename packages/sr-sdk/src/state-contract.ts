/** State values crossing the creator iframe boundary are JSON values. */
export type StateScope = 'global' | 'session' | 'message';
export type StateValue = null | boolean | number | string | StateValue[] | { [key: string]: StateValue };

export type StateEvent = {
  event: 'state.changed';
  data: { path: string; scope: StateScope; value: StateValue };
};

/** Proposed atomic state contract. The runtime bridge is implemented separately. */
export interface SRStateAPI {
  getState(path: string, scope?: StateScope): Promise<StateValue | undefined>;
  batchGetState(entries: Array<{ path: string; scope?: StateScope }>): Promise<Array<{
    path: string;
    scope: StateScope;
    value: StateValue | undefined;
  }>>;
  updateState(path: string, value: StateValue, scope?: StateScope): Promise<Array<{
    path: string;
    scope: StateScope;
    success: boolean;
    message: string;
  }>>;
  batchUpdateState(entries: Array<{ path: string; value: StateValue; scope?: StateScope }>): Promise<Array<{
    path: string;
    scope: StateScope;
    success: boolean;
    message: string;
  }>>;
  subscribe(listener: (event: StateEvent) => void): () => void;
}
