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
  if (!draft.name.trim()) return '请填写连接名称。';
  if (!draft.providerId || !draft.modelId) return '请选择服务商和模型。';
  // Existing connections can still have their name or key repaired when the catalog is unavailable or has retired the model.
  if (!keepsSavedSelection(draft)) {
    if (!groups) return '模型目录尚未读取，请重试后选择模型。';
    if (!findCatalogModel(groups, draft.providerId, draft.modelId)) return '请选择当前服务商下的模型。';
  }
  if (!draft.id && !draft.apiKey.trim()) return '请填写 API Key。';
  if (draft.original && draft.providerId !== draft.original.providerId && !draft.apiKey.trim()) {
    return '更换服务商后请填写新的 API Key。';
  }
  return null;
}

const numberFormat = new Intl.NumberFormat('en-US');
const tokenCount = (value: number) => Number.isFinite(value) && value >= 0 ? numberFormat.format(value) + ' tokens' : '未提供';

export function cacheDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '未提供';
  if (seconds > 0 && seconds % 86400 === 0) return numberFormat.format(seconds / 86400) + ' 天';
  if (seconds > 0 && seconds % 3600 === 0) return numberFormat.format(seconds / 3600) + ' 小时';
  if (seconds > 0 && seconds % 60 === 0) return numberFormat.format(seconds / 60) + ' 分钟';
  return numberFormat.format(seconds) + ' 秒';
}

export type ModelFact = { field: string; label: string; value: string; detail?: string; wide?: boolean };
export function modelFacts(model: CatalogModel): ModelFact[] {
  const map = model.thinkingLevelMap;
  const mapping = map === null || map === undefined || !Object.keys(map).length
    ? '未提供映射'
    : Object.entries(map).map(([level, value]) => level + ' → ' + (value === null ? '不支持' : value)).join(' · ');
  const levels = model.thinkingLevels?.length ? model.thinkingLevels.join(' / ') : '未提供';
  const modalities = model.input?.map(value => value === 'text' ? '文本' : value === 'image' ? '图片' : value).join(' · ') || '未提供';
  return [
    { field: 'contextWindow', label: '上下文', value: tokenCount(model.contextWindow) },
    { field: 'maxTokens', label: '输出上限', value: tokenCount(model.maxTokens) },
    { field: 'reasoning', label: '思考能力', value: model.reasoning === true ? '支持' : model.reasoning === false ? '不支持' : '未提供' },
    { field: 'input', label: '输入模态', value: modalities },
    { field: 'api', label: 'API 协议', value: model.api || '未提供' },
    { field: 'promptCache', label: '提示词缓存', value: model.promptCache
      ? '短 ' + cacheDuration(model.promptCache.short) + ' · 长 ' + cacheDuration(model.promptCache.long) : '未提供',
      detail: model.promptCache && Object.values(model.promptCache).some(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
        ? '目录参考保留时长' : undefined },
    { field: 'thinkingLevelMap', label: '思考级别映射', value: mapping, detail: '可用档位：' + levels, wide: true },
  ];
}
