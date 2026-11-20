import type { NarrativeOutput, ActionSuggestionsOutput } from '../../../modules/sessions/service.js';
import type { StateService } from '../../../modules/state/service.js';
import { extractCapability, type CapabilityExtraction } from './parser.js';
import { processActionSuggestions } from './action-suggestions.js';
import { failedStateOutput, processStateUpdates, type StatePostprocessResult } from './state-update.js';

type Capability = 'state_update' | 'action_suggestions';
export type PostprocessObserver = (event: string, data: Record<string, unknown>) => void;

/** Each capability owns extraction and processing; no shared tail-validity gate. */
export function processNarrativeOutput(text: string, state: Pick<StateService, 'prepareMessageUpdates'>,
  context: { sessionId: string; parentId: string; allowedRoots: readonly string[] }, observe?: PostprocessObserver) {
  const report = (event: string, data: Record<string, unknown>) => {
    try { void Promise.resolve(observe?.(event, structuredClone(data))).catch(() => {}); }
    catch { /* Diagnostics never change capability results. */ }
  };
  const extract = (name: Capability): CapabilityExtraction => {
    let extraction: CapabilityExtraction;
    try { extraction = extractCapability(text, name); }
    catch (error) {
      report(name + '.raw', { tagStatus: 'extraction_error', source: 'unparsed_model_output', raw: text });
      throw error;
    }
    report(name + '.raw', {
      tagStatus: extraction.status, blocks: extraction.blocks,
      // A damaged own tag has no valid block: retain the real source for diagnosis, never recover it for execution.
      ...(extraction.status === 'invalid_tag' ? { source: 'unparsed_model_output', raw: text }
        : { source: 'block_contents' }),
    });
    return extraction;
  };

  let stateResult: StatePostprocessResult;
  try { stateResult = processStateUpdates(state, context, extract('state_update')); }
  catch { stateResult = { output: failedStateOutput(), snapshot: null, change: null }; }
  report('state_update.result', { phase: 'prepared', ...stateResult.output });

  let suggestions: ActionSuggestionsOutput;
  try { suggestions = processActionSuggestions(extract('action_suggestions')); }
  catch {
    suggestions = { status: 'processing_error', items: [], results: [],
      errors: [{ errorCode: 'OUTPUT_PROCESSING_FAILED' }] };
  }
  report('action_suggestions.result', { phase: 'prepared', ...suggestions });

  const output: NarrativeOutput = { stateUpdate: stateResult.output, actionSuggestions: suggestions };
  return { output, state: stateResult.snapshot, change: stateResult.change };
}
