import { resolvePostprocessPrompts, systemVariableNames } from '../../../../modules/presets/service.js';
import { AppError } from '../../../../errors.js';
import type { ModelInfo, ModelMessage, ModelParameters } from '../../../../infrastructure/model/client.js';
import type { ContextSnapshot } from '../../capture.js';
import type { CharacterSpriteCatalogItem } from '../../../../modules/worlds/service.js';
import { resolveContextCapabilities } from '../../capabilities.js';
import type { ContextDiagnostics, ContextNodeDiagnostic } from '../../diagnostics.js';
import { contextBudget } from '../../lib/budget.js';
import { estimateInputTokens } from '../../lib/estimate.js';
import { parsePromptTemplate } from '../../../../lib/prompt-template.js';
import { readStateVariable } from '../../lib/state-variable.js';
import { renderModelNotes } from '../model-notes/index.js';
import { postprocessProtocol } from './protocol.js';

export type ContextComposition = { systemBytes: number; summaryBytes: number; historyBytes: number };
const emptyComposition = (): ContextComposition => ({ systemBytes: 0, summaryBytes: 0, historyBytes: 0 });
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');
// Keep composition comparable across runs; this framing is a convention, not billed tokens.
const messageOverhead = 16;

export type CompiledNarrativeContext = {
  messages: ModelMessage[];
  maxTokens: number;
  modelParameters: ModelParameters;
  estimatedInputTokens: number;
  inputBudget: number;
  activeRoots: string[];
  characterSpriteCatalog: readonly CharacterSpriteCatalogItem[];
  context: {
    apiModelConfigId: string;
    contextWindowTokens: number;
    contextComposition: ContextComposition;
  };
  diagnostics: ContextDiagnostics;
};

/** Pure compilation of the selected history; budget enforcement belongs to context preparation. */
export function compileNarrativeContext(snapshot: ContextSnapshot, model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>): CompiledNarrativeContext {
  const config = snapshot.preset.config, messages: ModelMessage[] = [];
  const nodes: ContextNodeDiagnostic[] = [], composition = emptyComposition();
  const capabilities = resolveContextCapabilities(config, snapshot.materials, snapshot.characterSpriteCatalog);
  const enabledSources: Record<string, boolean> = {
    'state-update': capabilities.worldState, 'action-suggestions': capabilities.actionSuggestions,
    'character-sprite': capabilities.characterSprite,
  };
  const readVariable = (name: typeof systemVariableNames[number]) => name === 'characterSprite.catalog' && !capabilities.characterSprite
    ? { type: 'text' as const, value: '' } : snapshot.materials.variables[name];
  let inputCount = 0, historyCount = 0, summaryCount = 0;
  for (const node of config.nodes) {
    if (node.kind === 'postprocess') continue;
    const diagnostic: ContextNodeDiagnostic = {
      id: node.id, name: node.name, kind: node.kind, role: node.role, enabled: node.enabled,
      included: false, reason: node.enabled ? 'empty' : 'disabled', source: 'preset', messageIndexes: [],
    };
    nodes.push(diagnostic);
    if (!node.enabled) continue;
    const startIndex = messages.length;
    const modelNoteEntryIds: string[] = [];
    let pending = '', pendingComposition = emptyComposition();
    const append = (value: string, category: keyof ContextComposition) => {
      pending += value;
      pendingComposition[category] += byteLength(value);
    };
    const flush = () => {
      if (pending.trim() && (node.id !== 'userInput' || snapshot.inputEntryId !== null)) {
        messages.push({ role: node.role === 'auto' ? 'system' : node.role, content: pending, timestamp: 0 });
        composition.systemBytes += pendingComposition.systemBytes + messageOverhead;
        composition.summaryBytes += pendingComposition.summaryBytes;
        composition.historyBytes += pendingComposition.historyBytes;
      }
      pending = '';
      pendingComposition = emptyComposition();
    };
    for (const segment of parsePromptTemplate(node.prompt, systemVariableNames)) {
      if (segment.type === 'text') { append(segment.value, 'systemBytes'); continue; }
      if (segment.type === 'state') {
        append(readStateVariable(segment, snapshot.views, snapshot.materials.visibleRoots), 'systemBytes');
        continue;
      }
      if (segment.name === 'history.summary') summaryCount++;
      if (segment.name === 'input.text') {
        inputCount++;
        if (node.id !== 'userInput' || node.role !== 'user') throw new AppError('INVALID_NARRATIVE_TEMPLATE');
      }
      if (segment.name === 'history.messages') {
        historyCount++;
        if (node.id !== 'chatHistory') throw new AppError('INVALID_NARRATIVE_TEMPLATE');
      }
      const variable = readVariable(segment.name);
      if (variable.type === 'text') {
        append(variable.value, segment.name === 'history.summary' ? 'summaryBytes'
          : segment.name === 'input.text' ? 'historyBytes' : 'systemBytes');
      }
      else {
        flush();
        for (const item of variable.value) {
          const notes = snapshot.modelNotes.get(item.id)?.filter(note => enabledSources[note.source] !== false);
          if (notes?.length) modelNoteEntryIds.push(item.id);
          const content = renderModelNotes(item.text, notes);
          messages.push({ role: item.role, content, timestamp: item.timestamp });
          composition.historyBytes += byteLength(content) + messageOverhead;
        }
      }
    }
    flush();
    diagnostic.messageIndexes = Array.from({ length: messages.length - startIndex }, (_, index) => startIndex + index);
    diagnostic.included = diagnostic.messageIndexes.length > 0;
    diagnostic.reason = diagnostic.included ? 'included' : 'empty';
    if (modelNoteEntryIds.length) diagnostic.modelNoteEntryIds = modelNoteEntryIds;
  }
  if (inputCount !== 1 || historyCount !== 1) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
  if (config.contextStrategy.strategy === 'rolling_summary' && summaryCount !== 1) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
  const prompts = resolvePostprocessPrompts(config);
  const render = (prompt: string): string => parsePromptTemplate(prompt, systemVariableNames).map(segment => {
    if (segment.type === 'text') return segment.value;
    if (segment.type === 'state') return readStateVariable(segment, snapshot.views, snapshot.materials.visibleRoots);
    const variable = readVariable(segment.name);
    // Postprocessing instructions cannot duplicate the current input or historical message sequence.
    if (segment.name === 'input.text' || segment.name === 'history.messages' || segment.name === 'history.summary' || variable.type !== 'text') {
      throw new AppError('INVALID_NARRATIVE_TEMPLATE');
    }
    return variable.value;
  }).join('');
  const capabilityIndex = messages.length;
  const capabilityParts: string[] = [];
  for (const id of ['worldState', 'actionSuggestions', 'characterSprite'] as const) {
    const configured = config.nodes.find(node => node.id === id && node.kind === 'postprocess');
    if (!configured) continue;
    const included = capabilities[id];
    nodes.push({
      id, name: configured.name, kind: 'postprocess', role: 'system', enabled: configured.enabled,
      included, reason: !configured.enabled ? 'disabled' : included ? 'included'
        : id === 'characterSprite' ? 'no_character_sprites' : 'no_active_state',
      source: 'preset', messageIndexes: included ? [capabilityIndex] : [],
    });
    if (included) capabilityParts.push(render(prompts[id]!));
  }
  if (capabilityParts.length) {
    capabilityParts.push(postprocessProtocol(capabilities, snapshot.materials.activeRoots.length > 0));
    nodes.push({ id: 'postprocessProtocol', name: '能力输出协议', kind: 'protocol', role: 'system', enabled: true,
      included: true, reason: 'included', source: 'platform', messageIndexes: [capabilityIndex] });
    const capabilityContent = capabilityParts.join('\n\n');
    messages.push({ role: 'system', timestamp: 0, content: capabilityContent });
    composition.systemBytes += byteLength(capabilityContent) + messageOverhead;
  }
  const { maxTokens, inputBudget } = contextBudget(config, model);
  const estimatedInputTokens = estimateInputTokens(messages);
  return {
    messages, maxTokens, inputBudget, estimatedInputTokens, activeRoots: [...snapshot.materials.activeRoots],
    characterSpriteCatalog: snapshot.characterSpriteCatalog,
    context: {
      apiModelConfigId: snapshot.session.apiModelConfigId, contextWindowTokens: model.contextWindow,
      contextComposition: composition,
    },
    diagnostics: {
      nodes, characters: snapshot.materials.selection.characters, lore: snapshot.materials.selection.lore,
      activeRoots: [...snapshot.materials.activeRoots], messageCount: messages.length, estimatedInputTokens, inputBudget,
    },
    modelParameters: config.modelParameters,
  };
}
