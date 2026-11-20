import type { ActionSuggestionsOutput } from '../../../modules/sessions/service.js';
import type { CapabilityExtraction } from './parser.js';
import { parseStrictJson } from './strict-json.js';

type Candidate = { valid: boolean; items: string[]; rejected: boolean };

function validateItems(value: unknown[]): Candidate {
  const items: string[] = [];
  const seen = new Set<string>();
  let rejected = false;
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!text || Array.from(text).length > 50 || seen.has(text)) {
      rejected = true;
      continue;
    }
    seen.add(text);
    items.push(text);
  }
  return { valid: value.length === 0 || items.length > 0, items, rejected };
}

/** Invalid candidates cannot erase an earlier valid one; three suggestions are a prompt target. */
export function processActionSuggestions(extraction: CapabilityExtraction): ActionSuggestionsOutput {
  if (extraction.status === 'invalid_tag') {
    return { status: 'invalid_tag', items: [], errors: [{ errorCode: 'OUTPUT_TAG_INVALID' }] };
  }
  if (extraction.status === 'missing' || extraction.status === 'empty') {
    return { status: 'no_suggestions', items: [] };
  }
  let items: string[] = [];
  const errors: { errorCode: string }[] = [];
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
      if (candidate.rejected) failure = 'invalid_suggestions';
      if (candidate.valid) items = candidate.items;
    }
    return {
      status: items.length ? failure ? 'partial_success' : 'success' : failure ?? 'no_suggestions',
      items, ...(errors.length ? { errors } : {}),
    };
  } catch {
    return { status: 'processing_error', items: [],
      errors: [{ errorCode: 'ACTION_SUGGESTIONS_PROCESSING_FAILED' }] };
  }
}
