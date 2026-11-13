import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Api, Model } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../common/error-codes.js';
import { RuntimeError } from './shared/errors.js';
import type { RunStore } from './persistence/run-store.js';
import type { ModelClient } from './model/model-client.js';
import type { CapabilityConfig, CapabilityOverrides, PublicCapabilities } from './narrative/extension-contract.js';
import type { RuntimeConfig } from './types.js';

export const CONTEXT_WINDOWS = { compact: 131_072, standard: 262_144, extended: 524_288 } as const;
const prompt = z.string().refine(value => Array.from(value).length <= 2000);
const stateCapability = z.object({ enabled: z.boolean().optional(), prompt: prompt.optional() }).strict();
const suggestionsCapability = z.object({
  enabled: z.boolean().optional(), count: z.number().int().min(2).max(4).optional(), prompt: prompt.optional(),
}).strict();
export const capabilitiesSchema = z.object({
  state_update: stateCapability.optional(), action_suggestions: suggestionsCapability.optional(),
}).strict();
export const capabilityOverridesSchema = z.object({
  state_update: z.boolean().optional(), action_suggestions: z.boolean().optional(),
}).strict();
export const DEFAULT_CAPABILITIES: CapabilityConfig = {
  state_update: { enabled: true, prompt: '' },
  action_suggestions: { enabled: false, count: 3, prompt: '' },
};
export function normalizeCapabilities(value: unknown): CapabilityConfig {
  const parsed = capabilitiesSchema.safeParse(value === undefined ? {} : value);
  if (!parsed.success) throw new RuntimeError(ErrorCodes.INVALID_CAPABILITY_CONFIG);
  return {
    state_update: { ...DEFAULT_CAPABILITIES.state_update, ...parsed.data.state_update },
    action_suggestions: { ...DEFAULT_CAPABILITIES.action_suggestions, ...parsed.data.action_suggestions },
  };
}
export function mergeCapabilities(base: unknown, patch: unknown): CapabilityConfig {
  const current = normalizeCapabilities(base);
  const parsed = capabilitiesSchema.safeParse(patch === undefined ? {} : patch);
  if (!parsed.success) throw new RuntimeError(ErrorCodes.INVALID_CAPABILITY_CONFIG);
  return normalizeCapabilities({
    state_update: { ...current.state_update, ...parsed.data.state_update },
    action_suggestions: { ...current.action_suggestions, ...parsed.data.action_suggestions },
  });
}
export function effectiveCapabilities(base: unknown, overrides: CapabilityOverrides): CapabilityConfig {
  const result = normalizeCapabilities(base);
  for (const id of ['state_update', 'action_suggestions'] as const)
    if (Object.hasOwn(overrides, id)) result[id].enabled = overrides[id]!;
  return result;
}
export function publicCapabilities(config: RuntimeConfig, active: ReadonlySet<string> = new Set()): PublicCapabilities {
  return {
    stateUpdate: { enabled: config.extensions.state_update.enabled,
      required: config.execution.mode === 'direct' && config.extensions.state_update.enabled && active.size > 0 },
    actionSuggestions: { enabled: config.extensions.action_suggestions.enabled,
      count: config.extensions.action_suggestions.count },
    revision: config.capabilityRevision,
  };
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Synchronous config snapshot: called while SRRuntime owns admission, before any await. */
export function resolveRuntimeConfig(store: RunStore, client: ModelClient, sessionId: string): RuntimeConfig {
  const session = store.session(sessionId);
  if (!session) throw new RuntimeError(ErrorCodes.SESSION_NOT_FOUND);
  if (!session.preset_id) throw new RuntimeError(ErrorCodes.PRESET_NOT_SELECTED);
  const row = store.preset(String(session.preset_id));
  if (!row) throw new RuntimeError(ErrorCodes.PRESET_NOT_FOUND);
  const preset = JSON.parse(String(row.config_json));
  if (!session.api_model_config_id) throw new RuntimeError(ErrorCodes.API_MODEL_CONFIG_NOT_SELECTED);
  const modelRow = store.modelConfig(String(session.api_model_config_id));
  if (!modelRow) throw new RuntimeError(ErrorCodes.API_MODEL_CONFIG_NOT_FOUND);
  const resolved = client.resolve(String(modelRow.provider_id), String(modelRow.model_id));
  if (!resolved) throw new RuntimeError(ErrorCodes.MODEL_NOT_FOUND);
  const model: Model<Api> = structuredClone(resolved);
  const output = preset.budget?.max_output_tokens;
  const strategy = preset.budget?.context_strategy;
  if (!Number.isInteger(output) || output <= 0 || !Object.hasOwn(CONTEXT_WINDOWS, strategy))
    throw new RuntimeError(ErrorCodes.INVALID_PRESET_BUDGET);
  const temperature = preset.model_parameters?.temperature;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2))
    throw new RuntimeError(ErrorCodes.INVALID_MODEL_PARAMETERS);
  const mode = session.execution_mode ?? 'agent';
  if (mode !== 'direct' && mode !== 'agent') throw new RuntimeError(ErrorCodes.INVALID_SESSION);
  const overrides = capabilityOverridesSchema.safeParse(JSON.parse(String(session.capability_overrides_json ?? '{}')));
  if (!overrides.success) throw new RuntimeError(ErrorCodes.INVALID_CAPABILITY_CONFIG);
  return deepFreeze({
    version: 1,
    execution: { mode },
    model: { configId: String(session.api_model_config_id), credentialRef: String(modelRow.credential_ref), definition: model },
    generation: { maxOutputTokens: output, temperature },
    preset: { id: String(session.preset_id), hash: fingerprint(preset), nodes: structuredClone(preset.nodes), summaryPrompt: String(preset.summary_prompt ?? '') },
    contextPolicy: { windowPreset: strategy, measurement: 'current_request', safetyMarginTokens: 1024,
      summary: { inputRatio: 0.75, maxOutputTokens: Math.min(2048, model.maxTokens) },
      overflow: { strategy: 'summarize_history', keepRecentTurns: 5, maxPassesPerRequest: 2, maxSummaryCallsPerRun: 8 } },
    extensions: effectiveCapabilities(preset.capabilities, overrides.data),
    capabilityRevision: Number(session.capability_revision ?? 0),
    agentPolicy: { allowedTools: ['update_state'] },
  } as RuntimeConfig);
}
