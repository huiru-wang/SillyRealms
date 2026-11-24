import { AppError } from '../../errors.js';
import { postprocessNodeIds, type NarrativePresetConfig } from './schema.js';

export type PostprocessNodeId = typeof postprocessNodeIds[number];
export type PostprocessPrompts = Partial<Record<PostprocessNodeId, string>>;

/** Only explicitly declared, enabled nodes contribute instructions; defaults belong to templates. */
export function resolvePostprocessPrompts(config: Pick<NarrativePresetConfig, 'nodes'>): PostprocessPrompts {
  const prompts: PostprocessPrompts = {};
  for (const id of postprocessNodeIds) {
    const node = config.nodes.find(candidate => candidate.id === id && candidate.kind === 'postprocess');
    if (!node?.enabled) continue;
    if (!node.prompt.trim()) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
    prompts[id] = node.prompt;
  }
  return prompts;
}
