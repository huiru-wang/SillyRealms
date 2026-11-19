import { AppError } from '../../errors.js';
import type { ModelInfo } from '../../infrastructure/model/client.js';
import type { Preset } from '../../modules/presets/service.js';

export function contextBudget(config: Preset['config'], model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>) {
  const { maxOutputTokens: maxTokens, maxContextTokens } = config.contextStrategy;
  if (![maxTokens, maxContextTokens, model.maxTokens, model.contextWindow].every(value => Number.isSafeInteger(value) && value > 0)
    || maxTokens > model.maxTokens) throw new AppError('INVALID_MODEL_BUDGET');
  const inputBudget = Math.min(maxContextTokens, model.contextWindow - maxTokens - 1024);
  if (inputBudget <= 0) throw new AppError('INVALID_MODEL_BUDGET');
  return { maxTokens, inputBudget, target: Math.floor(inputBudget * 0.6) };
}

export function summaryBudget(model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>) {
  const maxTokens = Math.min(2048, model.maxTokens);
  return { maxTokens, inputBudget: Math.min(Math.floor(model.contextWindow * 0.75), model.contextWindow - maxTokens - 1024) };
}
