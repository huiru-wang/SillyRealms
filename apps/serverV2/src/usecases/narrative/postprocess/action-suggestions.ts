import type { ActionSuggestionsOutput } from '../../../modules/sessions/service.js';
import type { CapabilityExtraction } from './parser.js';
import { parseStrictJson } from './strict-json.js';

type SuggestionResult = ActionSuggestionsOutput['results'][number];
type Candidate = { valid: boolean; items: string[]; results: SuggestionResult[] };

function validateItems(value: unknown[]): Candidate {
  const items: string[] = [], results: SuggestionResult[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      results.push({ status: 'invalid_suggestion', errorCode: 'ACTION_SUGGESTION_TYPE' });
      continue;
    }
    const text = item.trim();
    if (!text) {
      results.push({ status: 'empty_suggestion' });
      continue;
    }
    if (Array.from(text).length > 50 || seen.has(text)) {
      results.push({ status: 'invalid_suggestion',
        errorCode: seen.has(text) ? 'ACTION_SUGGESTION_DUPLICATE' : 'ACTION_SUGGESTION_TOO_LONG' });
      continue;
    }
    seen.add(text);
    items.push(text);
    results.push({ status: 'success' });
  }
  return { valid: value.length === 0 || items.length > 0, items, results };
}

/** Invalid candidates cannot erase an earlier valid one; three suggestions are a prompt target. */
export function processActionSuggestions(extraction: CapabilityExtraction): ActionSuggestionsOutput {
  if (extraction.status === 'invalid_tag') {
    return { status: 'invalid_tag', items: [], results: [], errors: [{ errorCode: 'OUTPUT_TAG_INVALID' }] };
  }
  if (extraction.status === 'missing' || extraction.status === 'empty') {
    return { status: 'no_suggestions', items: [], results: [] };
  }
  let items: string[] = [];
  const results: SuggestionResult[] = [], errors: { errorCode: string }[] = [];
  let failure: 'invalid_json' | 'invalid_suggestions' | undefined;
  try {
    for (const block of extraction.blocks) {
      if (!block.trim()) { items = []; continue; }
      let value: unknown;
      try { value = parseStrictJson(block); }
      catch {
        failure ??= 'invalid_json';
        errors.push({ errorCode: 'ACTION_SUGGESTIONS_INVALID_JSON' });
        continue;
      }
      if (!Array.isArray(value)) {
        failure = 'invalid_suggestions';
        errors.push({ errorCode: 'ACTION_SUGGESTIONS_NOT_ARRAY' });
        continue;
      }
      const candidate = validateItems(value);
      results.push(...candidate.results);
      if (candidate.results.some(item => item.status !== 'success')) failure = 'invalid_suggestions';
      if (candidate.valid) items = candidate.items;
    }
    return {
      status: items.length ? failure ? 'partial_success' : 'success' : failure ?? 'no_suggestions',
      items, results, ...(errors.length ? { errors } : {}),
    };
  } catch {
    return { status: 'processing_error', items: [], results: [],
      errors: [{ errorCode: 'ACTION_SUGGESTIONS_PROCESSING_FAILED' }] };
  }
}
