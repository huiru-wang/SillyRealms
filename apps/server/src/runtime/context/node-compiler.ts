import type { Message } from '@earendil-works/pi-ai';
import { parsePromptTemplate } from '../../domain/preset/template.js';
import { deepFreeze } from '../config.js';
import { processingPlan } from '../postprocess/registry.js';
import type { ContextComposition } from '../persistence/usage-store.js';
import { selectMaterials } from './materials.js';
import { assistantMessage, type CompilationInput, type CompiledContext, type PromptTrace } from './contracts.js';

const emptyComposition = (): ContextComposition => ({ systemBytes: 0, summaryBytes: 0, historyBytes: 0 });
const byteLength = (value: string) => Buffer.byteLength(value, 'utf8');
const messageOverhead = 16;

/** Shared pure compiler for candidate budget estimation and the final Provider request. */
export function compileContext(input: CompilationInput): CompiledContext {
  const materials = selectMaterials(input), trace: PromptTrace[] = [], messages: Message[] = [];
  const composition = emptyComposition();
  const plan = processingPlan(input.nodes, input.presetHash, materials.roots);
  for (const node of input.nodes) {
    const enabled = node.enabled && !(node.id === 'worldState' && !plan.state_update.required);
    const compiled: Message[] = [];
    let pending = '', pendingComposition = emptyComposition();
    const append = (value: string, category: keyof ContextComposition) => {
      pending += value;
      pendingComposition[category] += byteLength(value);
    };
    const flush = () => {
      if (pending.trim()) {
        const role = node.role === 'auto' ? 'system' : node.role;
        compiled.push(role === 'assistant' ? assistantMessage(pending) : { role, content: pending, timestamp: 0 });
        // Fixed message framing belongs to system overhead; content retains its actual source.
        composition.systemBytes += pendingComposition.systemBytes + messageOverhead;
        composition.summaryBytes += pendingComposition.summaryBytes;
        composition.historyBytes += pendingComposition.historyBytes;
      }
      pending = '';
      pendingComposition = emptyComposition();
    };
    if (enabled) for (const segment of parsePromptTemplate(node.prompt)) {
      if (segment.type === 'text') {
        append(segment.value, 'systemBytes');
        continue;
      }
      const variable = materials.variables[segment.name];
      if (variable.type === 'text') {
        append(variable.value, variable.category);
      } else {
        flush();
        for (const item of variable.value) {
          compiled.push(item.role === 'assistant' ? assistantMessage(item.text) : { role: 'user', content: item.text, timestamp: 0 });
          composition.historyBytes += byteLength(item.text) + messageOverhead;
        }
      }
    }
    flush();
    trace.push({ nodeId: node.id, name: node.name, role: node.role, enabled, messages: compiled });
    messages.push(...compiled);
  }
  return deepFreeze({ messages, trace, composition, activeRoots: materials.roots, postprocess: plan, diagnostics: materials.diagnostics });
}
