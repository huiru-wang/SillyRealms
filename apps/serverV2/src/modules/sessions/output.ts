import { z } from 'zod';

const diagnostic = z.string().min(1);
const errors = z.array(z.object({ errorCode: diagnostic }).strict()).optional();

export const stateUpdateOutputSchema = z.object({
  status: z.enum(['no_updates', 'success', 'partial_success', 'invalid_updates', 'invalid_tag', 'processing_error']),
  updates: z.array(z.object({
    path: z.string().min(1), value: z.json(), reason: z.string().optional(),
  }).strict()),
  results: z.array(z.object({
    status: z.enum(['success', 'invalid_json', 'invalid_update', 'invalid_path', 'invalid_value', 'processing_error']),
    path: z.string().optional(), errorCode: diagnostic.optional(),
    statePath: z.string().optional(), rulePath: z.string().optional(),
  }).strict()),
  errors,
}).strict();

export const actionSuggestionsOutputSchema = z.object({
  status: z.enum(['no_suggestions', 'success', 'partial_success', 'invalid_tag', 'invalid_json', 'invalid_suggestions', 'processing_error']),
  items: z.array(z.string().trim().min(1).refine(value => [...value].length <= 50)),
  results: z.array(z.object({
    status: z.enum(['success', 'empty_suggestion', 'invalid_suggestion']),
    errorCode: diagnostic.optional(),
  }).strict()),
  errors,
}).strict();

export const narrativeOutputSchema = z.object({
  stateUpdate: stateUpdateOutputSchema,
  actionSuggestions: actionSuggestionsOutputSchema,
}).strict();

export type NarrativeOutput = z.infer<typeof narrativeOutputSchema>;
export type StateUpdateOutput = z.infer<typeof stateUpdateOutputSchema>;
export type ActionSuggestionsOutput = z.infer<typeof actionSuggestionsOutputSchema>;
export type StateUpdateStatus = StateUpdateOutput['status'];
export type StateUpdateResult = StateUpdateOutput['results'][number];
export type ActionSuggestionsStatus = ActionSuggestionsOutput['status'];
export type ActionSuggestionResult = ActionSuggestionsOutput['results'][number];
