import { resolveBudget } from '../domain/preset-budget.js';
import { createHash } from 'node:crypto';
import type { Api,Model } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../common/error-codes.js';
import { RuntimeError } from './shared/errors.js';
import type { PresetConfig } from '../domain/preset/schema.js';
import { decodePreset } from '../repositories/preset-repository.js';
import type { RunStore } from './persistence/run-store.js';
import type { ModelClient } from './model/model-client.js';
import type { RuntimeConfig } from './types.js';
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

export function presetFingerprint(preset:PresetConfig):string {
 return fingerprint({model_parameters:preset.model_parameters,context_strategy:preset.context_strategy,config_json:preset.config_json});
}

export function resolveRuntimeConfig(store:RunStore,client:ModelClient,sessionId:string):RuntimeConfig {
 const session=store.session(sessionId);if(!session)throw new RuntimeError(ErrorCodes.SESSION_NOT_FOUND);
 if(!session.preset_id)throw new RuntimeError(ErrorCodes.PRESET_NOT_SELECTED);
 const row=store.preset(String(session.preset_id));if(!row)throw new RuntimeError(ErrorCodes.PRESET_NOT_FOUND);
 let preset;try{preset=decodePreset(row);}catch{throw new RuntimeError(ErrorCodes.INVALID_PRESET);}
 if(!session.api_model_config_id)throw new RuntimeError(ErrorCodes.API_MODEL_CONFIG_NOT_SELECTED);
 const modelRow=store.modelConfig(String(session.api_model_config_id));if(!modelRow)throw new RuntimeError(ErrorCodes.API_MODEL_CONFIG_NOT_FOUND);
 const resolved=client.resolve(String(modelRow.provider_id),String(modelRow.model_id));if(!resolved)throw new RuntimeError(ErrorCodes.MODEL_NOT_FOUND);
 const model:Model<Api>=structuredClone(resolved),budget=resolveBudget(preset.context_strategy,model);
 return deepFreeze({model:{configId:String(session.api_model_config_id),credentialRef:String(modelRow.credential_ref),definition:model},generation:{maxOutputTokens:budget.max_output_tokens,temperature:preset.model_parameters.temperature},preset:{id:preset.id,hash:presetFingerprint(preset),nodes:preset.config_json.nodes},contextPolicy:{budget,safetyMarginTokens:1024,summary:{prompt:preset.context_strategy.summary_prompt,inputRatio:0.75,maxOutputTokens:Math.min(2048,model.maxTokens)},keepRecentTurns:5}});
}
