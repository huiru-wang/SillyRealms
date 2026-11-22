import { decodeParameters, encodedParametersSchema, encodeParameters } from './model-parameters.js';
import { z } from 'zod';
import { presetValueSchema } from './schema.js';
import type { PresetValue } from './types.js';

/** Portable preset document. These established protocol keys are not database columns. */
export type PresetDocument = {
  name: string;
  description: string | null;
  config_json: { schemaVersion: 3; nodes: PresetValue['config']['nodes'] };
  context_strategy: {
    strategy: PresetValue['config']['contextStrategy']['strategy'];
    max_context_tokens: number;
    max_output_tokens: number;
    summary_prompt: string;
  };
  model_parameters: ReturnType<typeof encodeParameters>;
};

const documentSchema = z.object({
  name: z.unknown(),
  description: z.unknown().optional(),
  config_json: z.object({ schemaVersion: z.literal(3), nodes: z.unknown() }).strict(),
  context_strategy: z.object({
    strategy: z.unknown(),
    max_context_tokens: z.unknown(),
    max_output_tokens: z.unknown(),
    summary_prompt: z.unknown(),
  }).strict(),
  model_parameters: encodedParametersSchema,
}).strict();

export function parsePresetDocument(input: unknown): PresetValue {
  const value = documentSchema.parse(input);
  return presetValueSchema.parse({
    type: 'narrative',
    name: value.name,
    description: value.description,
    config: {
      schemaVersion: 1,
      nodes: value.config_json.nodes,
      contextStrategy: {
        strategy: value.context_strategy.strategy,
        maxContextTokens: value.context_strategy.max_context_tokens,
        maxOutputTokens: value.context_strategy.max_output_tokens,
        summaryPrompt: value.context_strategy.summary_prompt,
      },
      modelParameters: decodeParameters(value.model_parameters),
    },
  });
}

export function toPresetDocument(value: PresetValue): PresetDocument {
  const { config } = value;
  return {
    name: value.name,
    description: value.description,
    config_json: { schemaVersion: 3, nodes: structuredClone(config.nodes) },
    context_strategy: {
      strategy: config.contextStrategy.strategy,
      max_context_tokens: config.contextStrategy.maxContextTokens,
      max_output_tokens: config.contextStrategy.maxOutputTokens,
      summary_prompt: config.contextStrategy.summaryPrompt,
    },
    model_parameters: encodeParameters(config.modelParameters),
  };
}
