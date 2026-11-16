import type {StudioPreset} from './types.js';
export function fromServer(raw:any):StudioPreset {
 return {id:raw.id,name:raw.name,description:raw.description??'',contextStrategy:raw.context_strategy.strategy,maxContextTokens:raw.context_strategy.max_context_tokens,maxOutputTokens:raw.context_strategy.max_output_tokens,temperature:raw.model_parameters?.temperature??1,summaryPrompt:raw.context_strategy.summary_prompt,style:{content:raw.config_json.nodes.find((n:any)=>n.id==='main')?.prompt.parts.filter((p:any)=>p.type==='text').map((p:any)=>p.value).join('')??'',enabled:true},customNodes:raw.config_json.nodes.filter((n:any)=>n.kind==='text').map((n:any)=>({...n,content:n.prompt.parts.filter((p:any)=>p.type==='text').map((p:any)=>p.value).join('')})),raw};
}
export function getPresetValidationError(p:StudioPreset):string|null{
 if(!p.summaryPrompt.trim()||!p.style.content.trim()||p.customNodes.some(n=>!n.content.trim()))return '提示词不能为空。';
 if(!p.name.trim())return '请输入预设名称。';
 if(!['rolling_summary','sliding_window'].includes(p.contextStrategy))return '请选择上下文策略。';
 if(!Number.isSafeInteger(p.maxContextTokens)||p.maxContextTokens<2||!Number.isSafeInteger(p.maxOutputTokens)||p.maxOutputTokens<1)return '请输入有效的上下文和输出预算。';
 if(!Number.isFinite(p.temperature)||p.temperature<0||p.temperature>2)return '温度必须在 0 到 2 之间。';
 const ids=new Set<string>();for(const n of p.customNodes){if(!n.id||ids.has(n.id)||!n.name.trim()||!['system','user','assistant'].includes(n.role))return '请检查自定义节点名称、角色和 ID。';ids.add(n.id);}
 return null;
}
export function fields(p:StudioPreset){return {name:p.name.trim(),description:p.description,context_strategy:{strategy:p.contextStrategy,max_context_tokens:p.maxContextTokens,max_output_tokens:p.maxOutputTokens,summary_prompt:p.summaryPrompt},model_parameters:{temperature:p.temperature}};}
export function presetPatch(p:StudioPreset){
 const text=(value:string)=>({parts:[{type:'text',value}]});
 const fixed=p.raw.config_json.nodes.filter((n:any)=>n.kind!=='text').map((n:any)=>n.id==='main'?{...n,prompt:text(p.style.content)}:n);
 const custom=p.customNodes.map(n=>({id:n.id,kind:'text',name:n.name,role:n.role,enabled:n.enabled,prompt:text(n.content)}));
 return {...fields(p),config_json:{schemaVersion:2,nodes:[fixed[0],...custom,...fixed.slice(1)]}};
}
