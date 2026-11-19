import { contextBudget } from './context-policy.js';
import { AppError } from '../../errors.js';
import type { ModelInfo, ModelMessage } from '../../infrastructure/model/client.js';
import type { NarrativeSnapshot } from './context.js';
import { systemVariableNames, type SystemVariableName } from './materials.js';

type Segment = { type: 'text'; value: string } | { type: 'variable'; name: SystemVariableName };
export type CompiledNarrativeContext = {
  messages: ModelMessage[];
  maxTokens: number;
  temperature?: number;
  thinkingEnabled: boolean;
  estimatedInputTokens: number;
  inputBudget: number;
};
const variables = new Set<string>(systemVariableNames);

/** Scan the template exactly once; substituted author/user values remain literal data. */
export function parsePromptTemplate(prompt: string): Segment[] {
  const segments: Segment[] = [];
  let literal = '';
  const flush = () => {
    if (literal) segments.push({ type: 'text', value: literal });
    literal = '';
  };
  for (let index = 0; index < prompt.length;) {
    if (prompt[index] === '\\') {
      if (prompt[index + 1] === '\\') { literal += '\\'; index += 2; continue; }
      if (prompt.startsWith('{{', index + 1)) { literal += '{{'; index += 3; continue; }
    }
    if (!prompt.startsWith('{{', index)) { literal += prompt[index]!; index++; continue; }
    const end = prompt.indexOf('}}', index + 2);
    if (end === -1) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
    const name = prompt.slice(index + 2, end).trim();
    if (!variables.has(name)) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
    flush();
    segments.push({ type: 'variable', name: name as SystemVariableName });
    index = end + 2;
  }
  flush();
  return segments;
}

/** Fixed local text estimate; this is neither measured usage nor automatic calibration. */
export function estimateInputTokens(messages: readonly ModelMessage[]): number {
  let tokens = 64;
  for (const message of messages) {
    let thirds = 0;
    for (const char of message.content) {
      thirds += char.codePointAt(0)! <= 127 ? 1
        : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)
          ? 3 : Buffer.byteLength(char, 'utf8') * 3;
    }
    tokens += 16 + Math.ceil(thirds / 3);
  }
  if (!Number.isSafeInteger(tokens)) throw new AppError('CONTEXT_BUDGET_EXCEEDED');
  return tokens;
}

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
    for (const segment of parsePromptTemplate(node.prompt)) {
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
        for (const item of variable.value) messages.push({ role: item.role, content: item.text, timestamp: item.timestamp });
      }
    }
    flush();
  }
  if (inputCount !== 1 || historyCount !== 1) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
  if (config.contextStrategy.strategy === 'rolling_summary' && summaryCount !== 1) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
  const { maxTokens, inputBudget } = contextBudget(config, model);
  const estimatedInputTokens = estimateInputTokens(messages);
  return {
    messages, maxTokens, inputBudget, estimatedInputTokens,
    ...(config.modelParameters.temperature === undefined ? {} : { temperature: config.modelParameters.temperature }),
    thinkingEnabled: config.modelParameters.thinkingEnabled,
  };
}
