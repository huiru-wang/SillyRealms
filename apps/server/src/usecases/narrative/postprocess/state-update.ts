import type { StateUpdateItem, StateUpdateOutput } from '../../../modules/sessions/service.js';
import type { PreparedMessageUpdates, StateService } from '../../../modules/state/service.js';
import type { CapabilityExtraction } from './parser.js';
import { parseJsonl } from './strict-json.js';

type StateContext = { sessionId: string; parentId: string; allowedRoots: readonly string[] };
export type StatePostprocessResult = Pick<PreparedMessageUpdates, 'snapshot' | 'change'> & {
  output: StateUpdateOutput;
};

export const failedStateOutput = (): StateUpdateOutput => ({
  status: 'processing_error', updates: [],
  errors: [{ errorCode: 'OUTPUT_PROCESSING_FAILED' }],
});

/** Strict JSON is already validated, but output's JSON schema strips __proto__ keys. */
function canRetainValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  return !Object.hasOwn(value, '__proto__') && Object.values(value).every(canRetainValue);
}

/** Retain original rejected fields only when they can be saved unchanged. */
function inputFields(value: unknown): Pick<StateUpdateItem, 'path' | 'value' | 'reason'> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return {
    ...(typeof row.path === 'string' ? { path: row.path } : {}),
    ...(Object.hasOwn(row, 'value') && canRetainValue(row.value) ? { value: row.value as StateUpdateItem['value'] } : {}),
    ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
  };
}

export function processStateUpdates(state: Pick<StateService, 'prepareMessageUpdates'>,
  context: StateContext, extraction: CapabilityExtraction): StatePostprocessResult {
  const empty = (output: StateUpdateOutput): StatePostprocessResult => ({ output, snapshot: null, change: null });
  if (extraction.status === 'invalid_tag') {
    return empty({ status: 'invalid_tag', updates: [], errors: [{ errorCode: 'OUTPUT_TAG_INVALID' }] });
  }
  if (extraction.status === 'missing' || extraction.status === 'empty') {
    return empty({ status: 'no_updates', updates: [] });
  }
  const rows = parseJsonl(extraction.blocks);
  if (!rows.length) return empty({ status: 'no_updates', updates: [] });
  const values = rows.flatMap(row => row.ok ? [row.value] : []);
  const invalidJson = (): StateUpdateItem => ({ status: 'invalid_json', errorCode: 'STATE_UPDATE_JSON_INVALID' });
  if (!values.length) return empty({ status: 'invalid_updates', updates: rows.map(invalidJson) });
  try {
    const prepared = state.prepareMessageUpdates({ ...context, updates: values });
    let index = 0, acceptedIndex = 0;
    const updates: StateUpdateItem[] = rows.map(row => {
      if (!row.ok) return invalidJson();
      const result = prepared.results[index++]!;
      return result.status === 'success'
        ? { status: 'success', ...prepared.updates[acceptedIndex++]! }
        : { ...inputFields(row.value), ...result, status: result.status };
    });
    const output: StateUpdateOutput = {
      status: updates.every(update => update.status === 'success') ? 'success'
        : updates.some(update => update.status === 'success') ? 'partial_success' : 'invalid_updates',
      updates,
    };
    return { output, snapshot: prepared.changed ? prepared.snapshot : null, change: prepared.change };
  } catch {
    return empty({
      ...failedStateOutput(),
      updates: rows.map(row => row.ok
        ? { ...inputFields(row.value), status: 'processing_error' as const, errorCode: 'STATE_UPDATE_PROCESSING_FAILED' }
        : invalidJson()),
    });
  }
}
