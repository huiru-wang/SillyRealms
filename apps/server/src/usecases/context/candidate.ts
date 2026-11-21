import type { ModelInfo } from '../../infrastructure/model/client.js';
import type { StateService } from '../../modules/state/service.js';
import type { NarrativeSnapshot } from './capture.js';
import { compileNarrativeContext } from './stages/assemble/index.js';
import type { CandidateEvaluator } from './stages/compact/plan.js';
import { projectHistory } from './stages/history/index.js';
import { selectNarrativeMaterials } from './stages/materials/index.js';

/** Re-evaluate scenario materials and the actual assembled request for every retained history candidate. */
export function createCandidateEvaluator(
  snapshot: NarrativeSnapshot,
  model: Pick<ModelInfo, 'contextWindow' | 'maxTokens'>,
  state: Pick<StateService, 'evaluateWhen'>,
): CandidateEvaluator {
  return (entries, summary) => {
    const history = projectHistory(entries);
    return compileNarrativeContext({
      ...snapshot, history,
      materials: selectNarrativeMaterials({
        world: snapshot.world, views: snapshot.views, playerId: snapshot.session.userCharacterId,
        inputText: snapshot.inputText, history, summary,
      }, state),
    }, model);
  };
}
