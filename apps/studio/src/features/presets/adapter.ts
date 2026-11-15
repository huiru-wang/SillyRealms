import type {StudioPreset} from './types.js';
export function fromServer(raw:any):StudioPreset {
 return {id:raw.id,name:raw.name,description:raw.description??'',contextStrategy:raw.budget.strategy,maxContextTokens:raw.budget.max_context_tokens,maxOutputTokens:raw.budget.max_output_tokens,temperature:raw.model_parameters?.temperature??1,summaryPrompt:raw.summary_prompt,style:{content:raw.nodes.find((n:any)=>n.id==='main')?.content??'',enabled:true},customNodes:raw.nodes.filter((n:any)=>n.kind==='text').map((n:any)=>({...n,content:n.content??''})),raw};
}
export function getPresetValidationError(p:StudioPreset):string|null{
 if(!p.name.trim())return '请输入预设名称。';
 if(!['rolling_summary','sliding_window'].includes(p.contextStrategy))return '请选择上下文策略。';
 if(!Number.isSafeInteger(p.maxContextTokens)||p.maxContextTokens<2||!Number.isSafeInteger(p.maxOutputTokens)||p.maxOutputTokens<1)return '请输入有效的上下文和输出预算。';
 if(!Number.isFinite(p.temperature)||p.temperature<0||p.temperature>2)return '温度必须在 0 到 2 之间。';
 const ids=new Set<string>();for(const n of p.customNodes){if(!n.id||ids.has(n.id)||!n.name.trim()||!['system','user','assistant'].includes(n.role))return '请检查自定义节点名称、角色和 ID。';ids.add(n.id);}
 return null;
}
export function fields(p:StudioPreset){return {name:p.name.trim(),description:p.description,summary_prompt:p.summaryPrompt,budget:{strategy:p.contextStrategy,max_context_tokens:p.maxContextTokens,max_output_tokens:p.maxOutputTokens},model_parameters:{...p.raw.model_parameters,temperature:p.temperature}};}
export function presetPatch(p:StudioPreset){
 const old=p.raw.nodes as any[],oldCustom=old.filter(n=>n.kind==='text'),oldIds=new Set(oldCustom.map(n=>n.id));
 const custom=p.customNodes.map(n=>({id:n.id,kind:'text',name:n.name,role:n.role,enabled:n.enabled,content:n.content}));
 const nextIds=new Set(custom.map(n=>n.id));
 // Preserve every system node and its contents, including legacy compatibility text.
 let index=0;const order:string[]=[];for(const node of old){if(node.kind==='system')order.push(node.id);else if(index<custom.length)order.push(custom[index++]!.id);}const extra=custom.slice(index).map(n=>n.id);if(extra.length){const anchor=index?order.indexOf(custom[index-1]!.id):order.indexOf('main');order.splice(anchor+1,0,...extra);}
 return {...fields(p),nodes:[{id:'main',content:p.style.content,enabled:true},...custom.filter(n=>oldIds.has(n.id))],add_nodes:custom.filter(n=>!oldIds.has(n.id)),remove_node_ids:oldCustom.filter(n=>!nextIds.has(n.id)).map(n=>n.id),nodes_order:order};
}
