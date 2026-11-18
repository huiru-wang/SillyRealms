import { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { offsetPage, readOffsetPagination } from '../http/pagination.js';
import { readJson, success } from '../http/response.js';
import type { CreatePresetInput, Preset, PresetListOptions, PresetService, UpdatePresetInput } from '../presets/service.js';

// Studio still splits a narrative preset into these protocol fields.
// Their semantic values are validated by PresetService after explicit name conversion.
const contextProtocol = z.object({
  strategy: z.unknown(),
  max_context_tokens: z.unknown(),
  max_output_tokens: z.unknown(),
  summary_prompt: z.unknown(),
}).strict();
const parametersProtocol = z.object({
  temperature: z.unknown().optional(),
  thinking_enabled: z.unknown().optional(),
}).strict();
const configProtocol = z.object({ schemaVersion: z.literal(3), nodes: z.unknown() }).strict();
const valueProtocol = z.object({
  type: z.unknown().optional(),
  name: z.unknown(),
  description: z.unknown().optional(),
  config_json: configProtocol,
  context_strategy: contextProtocol,
  model_parameters: parametersProtocol,
}).strict();
const createProtocol = valueProtocol.extend({ id: z.unknown().optional() }).strict();
const patchProtocol = valueProtocol.partial().strict();

type PresetProtocol = z.output<typeof patchProtocol>;

function configInput(input: PresetProtocol, current?: Preset['config']) {
  return {
    schemaVersion: 1,
    nodes: input.config_json === undefined ? current?.nodes : input.config_json.nodes,
    contextStrategy: input.context_strategy === undefined ? current?.contextStrategy : {
      strategy: input.context_strategy.strategy,
      maxContextTokens: input.context_strategy.max_context_tokens,
      maxOutputTokens: input.context_strategy.max_output_tokens,
      summaryPrompt: input.context_strategy.summary_prompt,
    },
    modelParameters: input.model_parameters === undefined ? current?.modelParameters : {
      ...(Object.hasOwn(input.model_parameters, 'temperature') ? { temperature: input.model_parameters.temperature } : {}),
      thinkingEnabled: input.model_parameters.thinking_enabled,
    },
  };
}

function presetSummary(preset: Preset) {
  return {
    id: preset.id, type: preset.type, name: preset.name, description: preset.description,
    createdAt: preset.createdAt, updatedAt: preset.updatedAt,
  };
}

function presetResponse(preset: Preset) {
  const { config } = preset;
  return {
    ...presetSummary(preset),
    config_json: { schemaVersion: 3, nodes: config.nodes },
    context_strategy: {
      strategy: config.contextStrategy.strategy,
      max_context_tokens: config.contextStrategy.maxContextTokens,
      max_output_tokens: config.contextStrategy.maxOutputTokens,
      summary_prompt: config.contextStrategy.summaryPrompt,
    },
    model_parameters: {
      ...(config.modelParameters.temperature === undefined ? {} : { temperature: config.modelParameters.temperature }),
      thinking_enabled: config.modelParameters.thinkingEnabled,
    },
  };
}

export function createPresetRoutes(presets: PresetService) {
  const routes = new Hono();

  routes.get('/', c => {
    const type = c.req.query('type') ?? 'narrative', scope = 'presets:' + type;
    const pagination = readOffsetPagination(c, scope, { defaultLimit: 100, maxLimit: 1000 });
    const { items, hasMore } = presets.listPage({ ...pagination, type: type as PresetListOptions['type'] });
    return success(c, offsetPage(items.map(presetSummary), hasMore, pagination, scope));
  });
  routes.get('/:id', c => success(c, { item: presetResponse(presets.require(c.req.param('id'))) }));
  routes.post('/', async c => {
    const input = createProtocol.parse(await readJson(c));
    const value = {
      ...(input.id === undefined ? {} : { id: input.id }),
      type: input.type === undefined ? 'narrative' : input.type,
      name: input.name, description: input.description, config: configInput(input),
    } as CreatePresetInput;
    return success(c, { item: presetResponse(presets.create(value)) }, 201);
  });
  routes.patch('/:id', async c => {
    const id = c.req.param('id'), input = patchProtocol.parse(await readJson(c));
    const patch: Record<string, unknown> = {};
    for (const key of ['type', 'name', 'description'] as const) {
      if (Object.hasOwn(input, key)) patch[key] = input[key];
    }
    if (input.config_json !== undefined || input.context_strategy !== undefined || input.model_parameters !== undefined) {
      patch.config = configInput(input, presets.require(id).config);
    }
    const item = presets.update(id, patch as UpdatePresetInput);
    if (!item) throw new AppError('PRESET_NOT_FOUND');
    return success(c, { item: presetResponse(item) });
  });
  routes.delete('/:id', c => {
    const id = c.req.param('id');
    if (!presets.delete(id)) throw new AppError('PRESET_NOT_FOUND');
    return success(c, { id });
  });

  return routes;
}
