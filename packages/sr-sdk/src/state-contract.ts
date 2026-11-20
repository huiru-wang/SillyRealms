/** State values crossing the creator iframe boundary are JSON values. */
export type StateScope = 'global' | 'session' | 'message';
export type StateValue = null | boolean | number | string | StateValue[] | { [key: string]: StateValue };

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
