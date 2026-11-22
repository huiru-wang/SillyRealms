import { z } from 'zod';
import type { NarrativePresetConfig } from './schema.js';

type Parameters = NarrativePresetConfig['modelParameters'];

/** The portable file and the SQLite JSON use the same parameter keys. Domain limits live in presetValueSchema. */
export const encodedParametersSchema = z.object({
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  thinking_enabled: z.boolean().optional(),
  thinking_level: z.string().optional(),
}).strict();

export function decodeParameters(value: z.infer<typeof encodedParametersSchema>) {
  return {
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.top_p === undefined ? {} : { topP: value.top_p }),
    ...(value.frequency_penalty === undefined ? {} : { frequencyPenalty: value.frequency_penalty }),
    ...(value.presence_penalty === undefined ? {} : { presencePenalty: value.presence_penalty }),
    thinkingEnabled: value.thinking_enabled,
    ...(value.thinking_level === undefined ? {} : { thinkingLevel: value.thinking_level }),
  };
}

export function encodeParameters(value: Parameters) {
  return {
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.topP === undefined ? {} : { top_p: value.topP }),
    ...(value.frequencyPenalty === undefined ? {} : { frequency_penalty: value.frequencyPenalty }),
    ...(value.presencePenalty === undefined ? {} : { presence_penalty: value.presencePenalty }),
    thinking_enabled: value.thinkingEnabled,
    ...(value.thinkingLevel === undefined ? {} : { thinking_level: value.thinkingLevel }),
  };
}
