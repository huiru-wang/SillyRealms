import type { Json } from '../../domain/state/state.js';
import { RuntimeError } from '../shared/errors.js';
import { parseExtensions } from './parser.js';
import { initialExtensions,type PostprocessPlan } from './contracts.js';
import { handleStateUpdate } from './state-update.js';
import { handleActionSuggestions } from './action-suggestions.js';
export function processResponse(tail:string|undefined,plan:PostprocessPlan,baseline:Record<string,Json>,modules:Record<string,any>){
 const parsed=parseExtensions(tail);if(parsed.error)throw new RuntimeError(parsed.error);
 const initial=initialExtensions(plan),state=handleStateUpdate(parsed.state_update,initial.stateUpdate,baseline,modules,new Set(plan.state_update.roots));
 return {workspace:state.workspace,extensions:{...initial,stateUpdate:state.result,actionSuggestions:handleActionSuggestions(parsed.action_suggestions,initial.actionSuggestions,state.result)}};
}
