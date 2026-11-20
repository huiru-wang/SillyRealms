import type { StateUpdateOutput } from '../../../modules/sessions/service.js';
import type { PreparedMessageUpdates, StateService } from '../../../modules/state/service.js';
import type { CapabilityExtraction } from './parser.js';
import { parseJsonl } from './strict-json.js';

type StateContext = { sessionId: string; parentId: string; allowedRoots: readonly string[] };
export type StatePostprocessResult = Pick<PreparedMessageUpdates, 'snapshot' | 'change'> & {
  output: StateUpdateOutput;
};

export const failedStateOutput = (): StateUpdateOutput => ({
  status: 'processing_error', updates: [], results: [],
  errors: [{ errorCode: 'OUTPUT_PROCESSING_FAILED' }],
});

export function processStateUpdates(state: Pick<StateService, 'prepareMessageUpdates'>,
  context: StateContext, extraction: CapabilityExtraction): StatePostprocessResult {
  const empty = (output: StateUpdateOutput): StatePostprocessResult => ({ output, snapshot: null, change: null });
  if (extraction.status === 'invalid_tag') {
    return empty({ status: 'invalid_tag', updates: [], results: [], errors: [{ errorCode: 'OUTPUT_TAG_INVALID' }] });
  }
  if (extraction.status === 'missing' || extraction.status === 'empty') {
    return empty({ status: 'no_updates', updates: [], results: [] });
  }
  const rows = parseJsonl(extraction.blocks);
  if (!rows.length) return empty({ status: 'no_updates', updates: [], results: [] });
  const values = rows.flatMap(row => row.ok ? [row.value] : []);
  const invalidJson = () => ({ status: 'invalid_json' as const, errorCode: 'STATE_UPDATE_JSON_INVALID' });
  if (!values.length) {
    return empty({ status: 'invalid_updates', updates: [], results: rows.map(invalidJson) });
  }
  try {
    const prepared = state.prepareMessageUpdates({ ...context, updates: values });
    let index = 0;
    const results = rows.map(row => row.ok ? prepared.results[index++]! : invalidJson());
    const output: StateUpdateOutput = {
      status: results.every(result => result.status === 'success') ? 'success'
        : prepared.updates.length ? 'partial_success' : 'invalid_updates',
      updates: prepared.updates, results,
    };
    return { output, snapshot: prepared.changed ? prepared.snapshot : null, change: prepared.change };
  } catch {
    return empty({
      ...failedStateOutput(),
      results: rows.map(row => row.ok
        ? { status: 'processing_error' as const, errorCode: 'STATE_UPDATE_PROCESSING_FAILED' }
        : invalidJson()),
    });
  }
}
