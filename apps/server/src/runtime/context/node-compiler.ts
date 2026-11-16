import type { Message } from '@earendil-works/pi-ai';
import { deepFreeze } from '../config.js';
import { processingPlan } from '../postprocess/registry.js';
import { selectMaterials } from './materials.js';
import { assistantMessage,type CompilationInput,type CompiledContext,type PromptTrace } from './contracts.js';
/** Pure entry used by preview, compaction estimation and the final Provider request. */
export function compileContext(input:CompilationInput):CompiledContext {
 const materials=selectMaterials(input),trace:PromptTrace[]=[],messages:Message[]=[];
 const plan=processingPlan(input.nodes,input.presetHash,materials.roots);
 for(const node of input.nodes){
  const enabled=node.enabled&&!(node.id==='worldState'&&!plan.state_update.required);
  const compiled:Message[]=[];let pending='';
  const flush=()=>{if(!pending.trim()){pending='';return;}const role=node.role==='auto'?'system':node.role;compiled.push(role==='assistant'?assistantMessage(pending):{role,content:pending,timestamp:0});pending='';};
  if(enabled)for(const part of node.prompt.parts){
   if(part.type==='text')pending+=materials.render(part.value);
   else if(part.name==='history.messages'){
    flush();for(const h of input.history.filter(h=>h.id!=='summary'))compiled.push(h.role==='assistant'?assistantMessage(h.text):{role:'user',content:h.text,timestamp:0});
   }else pending+=materials.texts[part.name]??'';
  }
  flush();trace.push({nodeId:node.id,name:node.name,role:node.role,enabled,messages:compiled});messages.push(...compiled);
 }
 return deepFreeze({messages,trace,activeRoots:materials.roots,postprocess:plan,diagnostics:materials.diagnostics});
}
export function estimateMessageBytes(messages:Message[],toolJson=''){return messages.reduce((sum,m)=>sum+Buffer.byteLength(JSON.stringify(m),'utf8')+16,Buffer.byteLength(toolJson,'utf8'));}
export function estimateNarrativeItemSize(item:{role:string;text:string}){return Buffer.byteLength(JSON.stringify({role:item.role,content:item.text}),'utf8')+16;}
