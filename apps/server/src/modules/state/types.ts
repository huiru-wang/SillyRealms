import type { JsonValue } from '../../infrastructure/database/connection.js';
import type { StateScope } from '@sillyrealms/sdk/state-validation';

export type StateQueryRow = { path: string; value?: JsonValue };
export type StateUpdate = { path: string; value: JsonValue };
export type PreparedStatePatch<T> = { snapshot: T; changed: boolean };

/** Transport-neutral field results matching the creator SDK's state contract. */
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

/** Effective scope change; path === '' replaces the entire normalized object snapshot. */
export type StateEvent = {
  event: 'state.changed';
  data: { path: string; scope: StateScope; value: JsonValue };
};

/** One model update accepted independently of the other output rows. */
export type AcceptedMessageUpdate = StateUpdate & { reason?: string };
export type MessageUpdateResult = {
  status: 'success' | 'invalid_update' | 'invalid_path' | 'invalid_value' | 'processing_error';
  path?: string;
  errorCode?: string;
  statePath?: string;
  rulePath?: string;
};
export type PreparedMessageUpdates = {
  change: StateEvent | null;
  snapshot: JsonValue[] | null;
  changed: boolean;
  updates: AcceptedMessageUpdate[];
  results: MessageUpdateResult[];
};
