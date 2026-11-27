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

const spriteIdentifier = z.string().min(1).refine(value => value.trim().length > 0);
const characterSpritePositionSchema = z.enum(['left', 'center', 'right', 'top', 'topleft', 'topright', 'truecenter']);
const characterSpriteFields = z.object({
  position: z.string(),
  characterId: spriteIdentifier,
  spriteId: spriteIdentifier,
}).strict();
const characterSpriteItemSchema = characterSpriteFields.extend({ position: characterSpritePositionSchema });

export const characterSpriteOutputSchema = z.object({
  status: z.enum(['success', 'partial_success', 'invalid_items', 'invalid_tag', 'processing_error']),
  items: z.array(characterSpriteItemSchema),
  errors: z.array(z.object({
    errorCode: diagnostic,
    line: z.number().int().positive().optional(),
  }).strict()).optional(),
}).strict().superRefine((output, context) => {
  const characters = new Set<string>(), positions = new Set<string>();
  for (const item of output.items) {
    if (characters.has(item.characterId) || positions.has(item.position)) {
      context.addIssue({ code: 'custom', message: 'Characters and positions must each be unique within a snapshot' });
      break;
    }
    characters.add(item.characterId);
    positions.add(item.position);
  }
  const hasErrors = Boolean(output.errors?.length);
  if (output.status === 'success') {
    if (hasErrors) context.addIssue({ code: 'custom', message: 'Successful snapshots cannot contain errors' });
  } else {
    if (!hasErrors) context.addIssue({ code: 'custom', message: 'Rejected rows or capabilities require diagnostics' });
    if (output.status === 'partial_success' ? output.items.length === 0 : output.items.length !== 0) {
      context.addIssue({ code: 'custom', message: 'Snapshot items must match the processing status' });
    }
    if ((output.status === 'partial_success' || output.status === 'invalid_items') &&
      output.errors?.some(error => error.line === undefined)) {
      context.addIssue({ code: 'custom', message: 'Row diagnostics require a nonempty data-line number' });
    }
  }
});

export type CharacterSpritePosition = z.infer<typeof characterSpritePositionSchema>;
export type CharacterSpriteItem = z.infer<typeof characterSpriteItemSchema>;
export type CharacterSpriteOutput = z.infer<typeof characterSpriteOutputSchema>;
export type CharacterSpriteStatus = CharacterSpriteOutput['status'];

/** Public domain parsing keeps schema ownership in Sessions and preserves exact IDs. */
export function parseCharacterSpriteItem(value: unknown):
  { ok: true; item: CharacterSpriteItem } | { ok: false; errorCode: 'invalid_item' | 'invalid_position' } {
  const fields = characterSpriteFields.safeParse(value);
  if (!fields.success) return { ok: false, errorCode: 'invalid_item' };
  const item = characterSpriteItemSchema.safeParse(fields.data);
  return item.success ? { ok: true, item: item.data } : { ok: false, errorCode: 'invalid_position' };
}

/** Validate persisted shape, never revalidate old IDs against today's world catalog. */
export function readCharacterSpriteOutput(value: unknown): CharacterSpriteOutput | null {
  const parsed = characterSpriteOutputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const narrativeOutputSchema = z.object({
  stateUpdate: stateUpdateOutputSchema,
  actionSuggestions: actionSuggestionsOutputSchema,
  characterSprite: characterSpriteOutputSchema.optional(),
}).strict();

/** Corrupt capability data stays isolated to its own processing result. */
export const storedNarrativeOutputSchema = narrativeOutputSchema.extend({
  stateUpdate: stateUpdateOutputSchema.catch({
    status: 'processing_error', updates: [], errors: [{ errorCode: 'STATE_UPDATE_STORED_RESULT_INVALID' }],
  }),
  actionSuggestions: actionSuggestionsOutputSchema.catch({
    status: 'processing_error', items: [], errors: [{ errorCode: 'ACTION_SUGGESTIONS_STORED_RESULT_INVALID' }],
  }),
  characterSprite: characterSpriteOutputSchema.catch({
    status: 'processing_error', items: [], errors: [{ errorCode: 'CHARACTER_SPRITE_STORED_RESULT_INVALID' }],
  }).optional(),
});

export type NarrativeOutput = z.infer<typeof narrativeOutputSchema>;
export type StateUpdateOutput = z.infer<typeof stateUpdateOutputSchema>;
export type StateUpdateItem = StateUpdateOutput['updates'][number];
export type ActionSuggestionsOutput = z.infer<typeof actionSuggestionsOutputSchema>;
export type StateUpdateStatus = StateUpdateOutput['status'];
export type ActionSuggestionsStatus = ActionSuggestionsOutput['status'];
