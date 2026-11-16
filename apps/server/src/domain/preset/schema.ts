import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { budgetSchema } from '../preset-budget.js';
export const systemIds=['main','personaInfo','characterInfo','worldInfo','chatHistory','userInput'] as const;
export const postprocessIds=['worldState','actionSuggestions'] as const;
const sources:Record<string,readonly string[]>={main:[],personaInfo:['persona.prompt'],characterInfo:['characters.prompts'],worldInfo:['world.lore'],chatHistory:['session.background','history.summary','history.messages'],userInput:['input.text'],worldState:['state.currentValues','state.updateRules'],actionSuggestions:[]};
const part=z.discriminatedUnion('type',[z.object({type:z.literal('text'),value:z.string().min(1)}).strict(),z.object({type:z.literal('source'),name:z.string().min(1)}).strict()]);
export const nodeSchema=z.object({id:z.string().min(1),name:z.string().min(1),kind:z.enum(['system','postprocess','text']),role:z.enum(['system','user','assistant','auto']),enabled:z.boolean(),prompt:z.object({parts:z.array(part).min(1)}).strict()}).strict();
export const configSchema=z.object({schemaVersion:z.literal(2),nodes:z.array(nodeSchema)}).strict().superRefine((config,ctx)=>{
 const nodes=config.nodes,ids=nodes.map(n=>n.id),bad=(message:string)=>ctx.addIssue({code:'custom',message});
 if(new Set(ids).size!==ids.length)bad('Duplicate node ID');
 for(const id of systemIds){const n=nodes.find(n=>n.id===id);if(!n||n.kind!=='system'||!n.enabled)bad('Required system node: '+id);}
 for(const n of nodes){
  const reserved=Object.hasOwn(sources,n.id),expectedKind=(systemIds as readonly string[]).includes(n.id)?'system':'postprocess';
  if(reserved&&(n.kind!==expectedKind||n.role!==(n.id==='chatHistory'?'auto':n.id==='userInput'?'user':'system')))bad('Invalid identity: '+n.id);
  if(!reserved&&(n.kind!=='text'||n.role==='auto'))bad('Invalid custom node: '+n.id);
  const bound=n.prompt.parts.filter(p=>p.type==='source').map(p=>p.name);
  if(bound.some(s=>!(sources[n.id]??[]).includes(s))||new Set(bound).size!==bound.length)bad('Invalid source: '+n.id);
  if(reserved&&(sources[n.id]??[]).some(s=>!bound.includes(s)))bad('Missing source: '+n.id);
  if(n.id==='userInput'&&(n.prompt.parts.length!==1||n.prompt.parts[0]?.type!=='source'))bad('User input must be verbatim');
 }
 const reserved=nodes.filter(n=>n.kind!=='text').map(n=>n.id);
 const expected=[...systemIds,...postprocessIds.filter(id=>ids.includes(id))];
 if(JSON.stringify(reserved)!==JSON.stringify(expected))bad('Invalid node order');
 if(nodes.some((n,i)=>n.kind==='text'&&(i<1||i>ids.indexOf('personaInfo'))))bad('Custom nodes must follow main');
});
export const contextStrategySchema=budgetSchema.extend({summary_prompt:z.string().trim().min(1)}).strict();
export const presetSchema=z.object({name:z.string().trim().min(1),description:z.string().nullable(),model_parameters:z.object({temperature:z.number().min(0).max(2).optional(),thinking_enabled:z.boolean().default(false)}).strict(),context_strategy:contextStrategySchema,config_json:configSchema}).strict();
export type PresetNode=z.infer<typeof nodeSchema>;
export type PresetConfig=z.infer<typeof presetSchema>;
export function defaultPreset():PresetConfig {return presetSchema.parse(JSON.parse(readFileSync(new URL('../../../resources/presets/default.json',import.meta.url),'utf8')));}
