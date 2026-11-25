import { DEFAULT_LOCALE } from '@sillyrealms/sdk/locale';
import { AppError } from '../../errors.js';
import { parsePromptTemplate } from '../../lib/prompt-template.js';
import { replyVariableNames } from '../../modules/presets/service.js';
import type { ModelClient, ModelMessage } from '../../infrastructure/model/client.js';
import type { ContextSources } from './capture.js';
import { contextBudget } from './lib/budget.js';
import { estimateInputTokens } from './lib/estimate.js';
import { readStateVariable } from './lib/state-variable.js';
import { readSummary } from './stages/compact/saved-summary.js';
import { historyBoundaries, narrativeMessage, projectHistory } from './stages/history/index.js';
import { selectNarrativeMaterials } from './stages/materials/index.js';

export type ReplyAssistSources = Omit<ContextSources, 'worlds'> & {
  worlds: Pick<ContextSources['worlds'], 'require'>;
  modelClient: Pick<ModelClient, 'resolve' | 'assertMessageOrder'>;
};
export type ReplyAssistInput = { sessionId: string; presetId: string; draftText: string; signal: AbortSignal };

/** Capture and compile synchronously under the session lock. No persistence or event ports. */
export function prepareReplyAssistContext(deps: ReplyAssistSources, input: ReplyAssistInput) {
  if (input.signal.aborted) throw new AppError('RUN_STOPPED');
  const session = deps.sessions.require(input.sessionId);
  const preset = deps.presets.require(input.presetId, 'reply_assist');
  if (preset.type !== 'reply_assist') throw new AppError('PRESET_TYPE_MISMATCH');
  if (!preset.apiModelConfigId) throw new AppError('REPLY_ASSIST_MODEL_NOT_CONFIGURED');
  const binding = deps.models.require(preset.apiModelConfigId);
  const model = deps.modelClient.resolve(binding.providerId, binding.modelId);
  const { inputBudget, maxTokens } = contextBudget(preset.config, model);
  const world = deps.worlds.require(session.worldId);
  const locale = deps.settings.getOptional()?.locale ?? DEFAULT_LOCALE;
  const views = deps.state.getViews({ worldId: world.id, sessionId: session.id, entryId: session.tipEntryId });
  const includeHistory = preset.config.nodes.some(node => node.id === 'chatHistory' && node.enabled);
  const entries = includeHistory ? deps.sessions.getHistory(session.id) : [];
  const messages = entries.filter(entry => entry.type === 'message');
  const boundaries = historyBoundaries(messages);
  // An interrupted, reasoning-only tail may have no visible prose. Keep the last usable scene.
  let lastVisible = messages.length - 1;
  while (lastVisible >= 0 && !narrativeMessage(messages[lastVisible]!)) lastVisible--;
  const protectedStart = boundaries.filter(start => start <= lastVisible).at(-1) ?? 0;
  const saved = readSummary(entries, messages, protectedStart);
  const task = input.draftText.trim() ? '根据以下尚未发送的草稿，保留玩家意图并输出完整的新草稿。\n\n' + input.draftText
    : '请以当前玩家身份生成下一条可直接发送的输入。';

  const compile = (start: number, summary: string) => {
    const history = projectHistory(messages.slice(start));
    const materials = selectNarrativeMaterials({ locale, world, views, playerId: session.userCharacterId,
      history, summary, inputText: input.draftText }, deps.state);
    const result: ModelMessage[] = [];
    for (const node of preset.config.nodes) {
      if (!node.enabled || (node.id === 'sessionGoal' && !session.runtimeConfig.replyAssistGoal.trim())) continue;
      let text = '';
      const flush = () => {
        if (text.trim()) result.push({ role: node.role === 'auto' ? 'system' : node.role, content: text });
        text = '';
      };
      for (const part of parsePromptTemplate(node.prompt, replyVariableNames)) {
        if (part.type === 'text') text += part.value;
        else if (part.type === 'state') text += readStateVariable(part, views, materials.visibleRoots);
        else if (part.name === 'session.reply.assist.goal') text += session.runtimeConfig.replyAssistGoal;
        else {
          const variable = materials.variables[part.name];
          if (variable.type === 'text') text += variable.value;
          else {
            flush();
            for (const item of variable.value) result.push({ role: item.role, content: item.text, timestamp: item.timestamp });
          }
        }
      }
      flush();
    }
    result.push({ role: 'user', content: task });
    return result;
  };
  for (const start of boundaries) {
    if (start < (saved?.coveredCount ?? 0) || start > protectedStart) continue;
    for (const summary of saved ? [saved.text, ''] : ['']) {
      const candidate = compile(start, summary);
      if (estimateInputTokens(candidate) > inputBudget) continue;
      deps.modelClient.assertMessageOrder(model, candidate);
      return { messages: candidate, model, maxTokens, credentialRef: binding.credentialRef, modelParameters: preset.config.modelParameters };
    }
  }
  throw new AppError('CONTEXT_BUDGET_EXCEEDED');
}
