import type { NarrativeOutput, ActionSuggestionsOutput } from '../../../modules/sessions/service.js';
import type { StateService } from '../../../modules/state/service.js';
import { extractCapability } from './parser.js';
import { processActionSuggestions } from './action-suggestions.js';
import { failedStateOutput, processStateUpdates, type StatePostprocessResult } from './state-update.js';

/** Each capability owns extraction and processing; no shared tail-validity gate. */
export function processNarrativeOutput(text: string, state: Pick<StateService, 'prepareMessageUpdates'>,
  context: { sessionId: string; parentId: string; allowedRoots: readonly string[] }) {
  let stateResult: StatePostprocessResult;
  try { stateResult = processStateUpdates(state, context, extractCapability(text, 'state_update')); }
  catch { stateResult = { output: failedStateOutput(), snapshot: null, change: null }; }

  let suggestions: ActionSuggestionsOutput;
  try { suggestions = processActionSuggestions(extractCapability(text, 'action_suggestions')); }
  catch {
    suggestions = { status: 'processing_error', items: [], results: [],
      errors: [{ errorCode: 'OUTPUT_PROCESSING_FAILED' }] };
  }
  const output: NarrativeOutput = { stateUpdate: stateResult.output, actionSuggestions: suggestions };
  return { output, state: stateResult.snapshot, change: stateResult.change };
}
