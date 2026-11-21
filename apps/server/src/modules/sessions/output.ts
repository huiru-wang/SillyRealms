import { z } from 'zod';

const diagnostic = z.string().min(1);
const errors = z.array(z.object({ errorCode: diagnostic }).strict()).optional();
const stateStatus = z.enum(['no_updates', 'success', 'partial_success', 'invalid_updates', 'invalid_tag', 'processing_error']);
const failedUpdateStatus = z.enum(['invalid_json', 'invalid_update', 'invalid_path', 'invalid_value', 'processing_error']);
const acceptedUpdate = z.object({
  status: z.literal('success'), path: z.string().min(1), value: z.json(), reason: z.string().optional(),
}).strict();
const rejectedUpdate = z.object({
  status: failedUpdateStatus,
  path: z.string().optional(), value: z.json().optional(), reason: z.string().optional(),
  errorCode: diagnostic.optional(), statePath: z.string().optional(), rulePath: z.string().optional(),
}).strict();

export const stateUpdateOutputSchema = z.object({
  status: stateStatus,
  updates: z.array(z.discriminatedUnion('status', [acceptedUpdate, rejectedUpdate])),
  errors,
}).strict();

export const actionSuggestionsOutputSchema = z.object({
  status: z.enum(['no_suggestions', 'success', 'partial_success', 'invalid_tag', 'invalid_json', 'invalid_suggestions', 'processing_error']),
  items: z.array(z.string().trim().min(1).refine(value => [...value].length <= 50)),
  errors,
}).strict();

export const narrativeOutputSchema = z.object({
  stateUpdate: stateUpdateOutputSchema,
  actionSuggestions: actionSuggestionsOutputSchema,
}).strict();

export type NarrativeOutput = z.infer<typeof narrativeOutputSchema>;
export type StateUpdateOutput = z.infer<typeof stateUpdateOutputSchema>;
export type StateUpdateItem = StateUpdateOutput['updates'][number];
export type ActionSuggestionsOutput = z.infer<typeof actionSuggestionsOutputSchema>;
export type StateUpdateStatus = StateUpdateOutput['status'];
export type ActionSuggestionsStatus = ActionSuggestionsOutput['status'];
