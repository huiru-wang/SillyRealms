import type { ModelInfo } from '../../infrastructure/model/client.js';
import type { StateService } from '../../modules/state/service.js';
import type { ContextSnapshot } from './capture.js';
import { compileNarrativeContext } from './stages/assemble/index.js';
import type { CandidateEvaluator } from './stages/compact/plan.js';
import { projectContextMessages } from './stages/history/index.js';
import { selectNarrativeMaterials } from './stages/materials/index.js';
import { promptSpriteCatalog } from './capabilities.js';

/** Re-evaluate scenario materials and the actual assembled request for every retained history candidate. */
export function createCandidateEvaluator(
  snapshot: ContextSnapshot,
  model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>,
  state: Pick<StateService, 'evaluateWhen'>,
): CandidateEvaluator {
  return (entries, summary) => {
    const projection = projectContextMessages(entries);
    const materials = selectNarrativeMaterials({
      locale: snapshot.locale, world: snapshot.world, views: snapshot.views, playerId: snapshot.session.userCharacterId,
      inputText: projection.inputText, history: projection.history, summary,
      characterSpriteCatalog: promptSpriteCatalog(snapshot.preset.config, snapshot.characterSpriteCatalog),
    }, state);
    return compileNarrativeContext({
      ...snapshot, ...projection, materials,
    }, model);
  };
}
