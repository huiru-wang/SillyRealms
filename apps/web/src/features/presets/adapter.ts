import {i18n} from '../../i18n/instance.ts';
import { samplingError, samplingFields, samplingValues } from './sampling.ts';
import type { WebPreset, PresetDetail, PresetInput } from './types.js';

const narrativeIds = ['main', 'personaInfo', 'characterInfo', 'worldInfo', 'worldState', 'chatHistory', 'userInput'];
const postprocessIds = ['stateUpdate', 'actionSuggestions', 'characterSprite'];

export function fromServer(raw: PresetDetail): WebPreset {
  return {
    id: raw.id, type: raw.type,
    ...(raw.type==='reply_assist'?{apiModelConfigId:raw.apiModelConfigId??null}:{}),
    name: raw.name,
    description: raw.description ?? '',
    contextStrategy: raw.config.contextStrategy.strategy,
    maxContextTokens: raw.config.contextStrategy.maxContextTokens,
    maxOutputTokens: raw.config.contextStrategy.maxOutputTokens,
    ...raw.config.modelParameters,
    summaryPrompt: raw.config.contextStrategy.summaryPrompt,
    nodes: structuredClone(raw.config.nodes),
    revision: raw.revision,
  };
}

export function getPresetValidationError(preset: WebPreset): string | null {
  if (preset.contextStrategy === 'rolling_summary' && !preset.summaryPrompt.trim()) return i18n.t('presets:theSummaryPromptCannotBeEmpty');
  if (!preset.name.trim()) return i18n.t('presets:enterAPresetName');
  if (!['rolling_summary', 'sliding_window'].includes(preset.contextStrategy)) return i18n.t('presets:selectAContextStrategy');
  if (!Number.isSafeInteger(preset.maxContextTokens) || preset.maxContextTokens < 2 || !Number.isSafeInteger(preset.maxOutputTokens) || preset.maxOutputTokens < 1) return i18n.t('presets:enterValidInputAndOutputTokenBudgets');
  for (const field of samplingFields) {
    const error = samplingError(field, preset[field.key]);
    if (error) return error;
  }
  if (typeof preset.thinkingEnabled !== 'boolean') return i18n.t('presets:chooseWhetherToEnableReasoning');
  if (preset.thinkingLevel !== undefined && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(preset.thinkingLevel)) return i18n.t('presets:selectAValidReasoningLevel');
  const reply = preset.type === 'reply_assist';
  const systemIds = reply ? ['main','sessionGoal','personaInfo','characterInfo','worldInfo','currentState','chatHistory'] : narrativeIds;
  const ids = new Set<string>();
  for (const node of preset.nodes) {
    if (!node.id || ids.has(node.id) || !node.name.trim() || typeof node.prompt !== 'string' || typeof node.enabled !== 'boolean') return i18n.t('presets:checkTheNodeNamePromptAndId');
    ids.add(node.id);
    const required = systemIds.includes(node.id), optional = !reply && postprocessIds.includes(node.id);
    if (required || optional) {
      const role = node.id === 'chatHistory' ? 'auto' : node.id === 'userInput' ? 'user' : 'system';
      if (node.kind !== (required ? 'system' : 'postprocess') || node.role !== role || (required && (!reply || node.id === 'main') && !node.enabled)) return i18n.t('presets:systemNodeRolesAndEnablementRulesCannot');
    } else if (node.kind !== 'text' || !['system', 'user', 'assistant'].includes(node.role)) {
      return i18n.t('presets:checkTheMessageRoleOfTheCustom');
    }
  }
  if (systemIds.some(id => !ids.has(id))) return i18n.t('presets:thePresetIsMissingRequiredSystemNodes');
  const builtinOrder = preset.nodes.filter(node => node.kind !== 'text').map(node => node.id);
  if (builtinOrder.join(',') !== [...systemIds, ...postprocessIds.filter(id => ids.has(id))].join(',')) return i18n.t('presets:keepSystemNodesInTheirRequiredOrder');
  return null;
}

export function presetInput(preset: WebPreset):PresetInput {
  return {
    type:preset.type??'narrative',...(preset.type==='reply_assist'?{apiModelConfigId:preset.apiModelConfigId??null}:{}),name:preset.name.trim(),description:preset.description,
    config:{
      schemaVersion:1,nodes:preset.nodes.map(({id,name,kind,role,enabled,prompt})=>({id,name,kind,role,enabled,prompt})),
      contextStrategy:{strategy:preset.contextStrategy,maxContextTokens:preset.maxContextTokens,maxOutputTokens:preset.maxOutputTokens,summaryPrompt:preset.summaryPrompt},
      modelParameters:{...samplingValues(preset),thinkingEnabled:preset.thinkingEnabled,...(preset.thinkingLevel===undefined?{}:{thinkingLevel:preset.thinkingLevel})},
    },
  };
}
