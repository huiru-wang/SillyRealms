import { resolvePostprocessPrompts } from '../../../../modules/presets/service.js';
import { AppError } from '../../../../errors.js';
import type { ModelInfo, ModelMessage } from '../../../../infrastructure/model/client.js';
import type { NarrativeSnapshot } from '../../capture.js';
import { contextBudget } from '../../lib/budget.js';
import { estimateInputTokens } from '../../lib/estimate.js';
import { parsePromptTemplate } from '../../lib/template.js';
import { systemVariableNames } from '../materials/index.js';
import { renderModelNotes } from '../model-notes/index.js';
import { postprocessProtocol } from './protocol.js';

export type CompiledNarrativeContext = {
  messages: ModelMessage[];
  maxTokens: number;
  temperature?: number;
  thinkingEnabled: boolean;
  estimatedInputTokens: number;
  inputBudget: number;
  activeRoots: string[];
};

/** Pure compilation of the selected history; budget enforcement belongs to context preparation. */
export function compileNarrativeContext(snapshot: NarrativeSnapshot, model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>): CompiledNarrativeContext {
  const config = snapshot.preset.config, messages: ModelMessage[] = [];
  let inputCount = 0, historyCount = 0, summaryCount = 0;
  for (const node of config.nodes) {
    if (!node.enabled || node.kind === 'postprocess') continue;
    let pending = '';
    const flush = () => {
      if (pending.trim()) messages.push({ role: node.role === 'auto' ? 'system' : node.role, content: pending, timestamp: 0 });
      pending = '';
    };
    for (const segment of parsePromptTemplate(node.prompt, systemVariableNames)) {
      if (segment.type === 'text') { pending += segment.value; continue; }
      if (segment.name === 'history.summary') summaryCount++;
      if (segment.name === 'input.text') {
        inputCount++;
        if (node.id !== 'userInput' || node.role !== 'user') throw new AppError('INVALID_NARRATIVE_TEMPLATE');
      }
      if (segment.name === 'history.messages') {
        historyCount++;
        if (node.id !== 'chatHistory') throw new AppError('INVALID_NARRATIVE_TEMPLATE');
      }
      const variable = snapshot.materials.variables[segment.name];
      if (variable.type === 'text') pending += variable.value;
      else {
        flush();
        for (const item of variable.value) messages.push({ role: item.role, content: renderModelNotes(item.text, snapshot.modelNotes.get(item.id)), timestamp: item.timestamp });
      }
    }
    flush();
  }
  if (inputCount !== 1 || historyCount !== 1) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
  if (config.contextStrategy.strategy === 'rolling_summary' && summaryCount !== 1) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
  const prompts = resolvePostprocessPrompts(config);
  const defaults = resolvePostprocessPrompts({ ...config, nodes: [] });
  const render = (prompt: string): string => parsePromptTemplate(prompt, systemVariableNames).map(segment => {
    if (segment.type === 'text') return segment.value;
    const variable = snapshot.materials.variables[segment.name];
    // Postprocessing instructions cannot duplicate the current input or historical message sequence.
    if (segment.name === 'input.text' || segment.name === 'history.messages' || segment.name === 'history.summary' || variable.type !== 'text') {
      throw new AppError('INVALID_NARRATIVE_TEMPLATE');
    }
    return variable.value;
  }).join('');
  const renderCapability = (name: keyof typeof prompts): string => {
    try { return render(prompts[name]); }
    catch { return render(defaults[name]); }
  };
  const hasState = snapshot.materials.activeRoots.length > 0;
  messages.push({ role: 'system', timestamp: 0, content: [
    ...(hasState ? [renderCapability('worldState')] : []),
    renderCapability('actionSuggestions'), postprocessProtocol(hasState),
  ].join('\n\n') });
  const { maxTokens, inputBudget } = contextBudget(config, model);
  const estimatedInputTokens = estimateInputTokens(messages);
  return {
    messages, maxTokens, inputBudget, estimatedInputTokens, activeRoots: [...snapshot.materials.activeRoots],
    ...(config.modelParameters.temperature === undefined ? {} : { temperature: config.modelParameters.temperature }),
    thinkingEnabled: config.modelParameters.thinkingEnabled,
  };
}
