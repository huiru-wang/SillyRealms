import type { PresetNode } from '../../domain/preset/schema.js';
import type { PostprocessPlan } from './contracts.js';
export function processingPlan(nodes:readonly PresetNode[],presetHash:string,roots:readonly string[]=[]):PostprocessPlan {
 const enabled=(id:string)=>nodes.some(n=>n.id===id&&n.kind==='postprocess'&&n.enabled);
 return Object.freeze({presetHash,state_update:Object.freeze({enabled:enabled('worldState'),required:enabled('worldState')&&roots.length>0,roots:Object.freeze([...roots])}),action_suggestions:Object.freeze({enabled:enabled('actionSuggestions')})});
}
