import {formatNumber} from '../../i18n/format.ts';
import {i18n} from '../../i18n/instance.ts';
import type { CatalogModel, ModelConfig, ModelDraft, ProviderModelGroup } from './types.ts';

export function modelDraft(config?: ModelConfig): ModelDraft {
  return config ? {
    id: config.id, name: config.name, providerId: config.providerId, modelId: config.modelId, apiKey: '',
    original: { providerId: config.providerId, modelId: config.modelId },
  } : { name: '', providerId: '', modelId: '', apiKey: '' };
}

export function findCatalogModel(groups: readonly ProviderModelGroup[], providerId: string, modelId: string): CatalogModel | undefined {
  return groups.find(provider => provider.providerId === providerId)?.models.find(model => model.modelId === modelId);
}

/** User-driven selection only; catalog loading never modifies a draft or fills a default. */
export function changeProvider(draft: ModelDraft, providerId: string): ModelDraft {
  if (draft.providerId === providerId) return draft;
  return { ...draft, providerId, modelId: '', apiKey: '' };
}

export function keepsSavedSelection(draft: ModelDraft): boolean {
  return !!draft.id && draft.original?.providerId === draft.providerId && draft.original.modelId === draft.modelId;
}

export function modelDraftError(draft: ModelDraft, groups: readonly ProviderModelGroup[] | null): string | null {
  if (!draft.name.trim()) return i18n.t('models:enterAConnectionName');
  if (!draft.providerId || !draft.modelId) return i18n.t('models:selectAProviderAndModel');
  // Existing connections can still have their name or key repaired when the catalog is unavailable or has retired the model.
  if (!keepsSavedSelection(draft)) {
    if (!groups) return i18n.t('models:loadTheModelCatalogBeforeSelectingA');
    if (!findCatalogModel(groups, draft.providerId, draft.modelId)) return i18n.t('models:selectAModelFromTheCurrentProvider');
  }
  if (!draft.id && !draft.apiKey.trim()) return i18n.t('models:enterAnApiKey');
  if (draft.original && draft.providerId !== draft.original.providerId && !draft.apiKey.trim()) {
    return i18n.t('models:enterANewApiKeyForThe');
  }
  return null;
}

const tokenCount = (value: number) => Number.isFinite(value) && value >= 0 ? formatNumber(value) + ' tokens' : i18n.t('models:notProvided');

export function cacheDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return i18n.t('models:notProvided');
  if (seconds > 0 && seconds % 86400 === 0) return i18n.t('models:duration.days',{count:seconds/86400,value:formatNumber(seconds/86400)});
  if (seconds > 0 && seconds % 3600 === 0) return i18n.t('models:duration.hours',{count:seconds/3600,value:formatNumber(seconds/3600)});
  if (seconds > 0 && seconds % 60 === 0) return i18n.t('models:duration.minutes',{count:seconds/60,value:formatNumber(seconds/60)});
  return i18n.t('models:duration.seconds',{count:seconds,value:formatNumber(seconds)});
}

export type ModelFact = { field: string; label: string; value: string; detail?: string; wide?: boolean };
export function modelFacts(model: CatalogModel): ModelFact[] {
  const levels = model.reasoning === false ? i18n.t('models:notSupported') : model.thinkingLevels?.length ? model.thinkingLevels.join(' / ') : i18n.t('models:notProvided');
  const modalities = model.input?.map(value => value === 'text' ? i18n.t('models:text') : value === 'image' ? i18n.t('models:images') : value).join(' · ') || i18n.t('models:notProvided');
  return [
    { field: 'contextWindow', label: i18n.t('models:contextWindow'), value: tokenCount(model.contextWindow) },
    { field: 'maxTokens', label: i18n.t('models:outputLimit'), value: tokenCount(model.maxTokens) },
    { field: 'reasoning', label: i18n.t('models:reasoning'), value: model.reasoning === true ? i18n.t('models:supported') : model.reasoning === false ? i18n.t('models:notSupported') : i18n.t('models:notProvided') },
    { field: 'input', label: i18n.t('models:inputModalities'), value: modalities },
    { field: 'api', label: i18n.t('models:apiProtocol'), value: model.api || i18n.t('models:notProvided') },
    { field: 'promptCache', label: i18n.t('models:promptCache'), value: model.promptCache
      ? i18n.t('models:cacheRetention',{short:cacheDuration(model.promptCache.short),long:cacheDuration(model.promptCache.long)}) : i18n.t('models:notProvided'),
      detail: model.promptCache && Object.values(model.promptCache).some(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        ? i18n.t('models:retentionDurationFromTheCatalog') : undefined },
    { field: 'thinkingLevels', label: i18n.t('models:availableReasoningLevels'), value: levels, wide: true },
  ];
}
