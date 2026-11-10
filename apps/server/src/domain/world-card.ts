import { ErrorCodes } from '../common/error-codes.js';
import { z } from 'zod';
import { applyOpening, initialState } from './state/state.js';
import { validateWhen } from './state/when.js';
import { atomicStateSchema } from './state/atomic-schema.js';

const nonblank=z.string().refine(v=>v.trim().length>0,'Expected nonempty text');
const id=z.string().trim().min(1);
const dict=z.record(z.string(),z.unknown());
const condition=z.string().superRefine((value,ctx)=>{
  try {validateWhen(value);} catch {ctx.addIssue({code:'custom',message:'Unsupported when expression'});}
});
const rules={
  mode:z.enum(['always','on_mention','never']).optional(), keywords:z.array(nonblank).optional(),
  keyword_logic:z.enum(['any','all']).optional(), exclude_keywords:z.array(nonblank).optional(), when:condition.optional(),
};
function keywords(rule:{mode?:string;keywords?:string[]},ctx:z.RefinementCtx) {
  if(rule.mode==='on_mention' && !rule.keywords?.length) ctx.addIssue({code:'custom',path:['keywords'],message:'Expected at least one keyword'});
}
const load=z.object(rules).superRefine(keywords);
const loreLoad=z.object({...rules,anchor:z.enum(['personaInfo','characterInfo','worldState','userInput']).optional(),position:z.enum(['before','after']).optional(),order:z.number().int().optional()}).superRefine(keywords);
const character=z.object({id,name:nonblank,description:z.string().optional(),prompt:z.string().optional(),avatar:z.string().optional(),order:z.number().int().optional(),player_selectable:z.boolean().optional(),load:load.optional()});
const opening=z.object({id,name:nonblank,content:nonblank,initial_state:dict.optional()});
const lore=z.object({id,title:z.string().optional(),content:nonblank,enabled:z.boolean().optional(),load:loreLoad.optional()});
function unique(items:{id:string}[],ctx:z.RefinementCtx) {
  const seen=new Set<string>();
  items.forEach((item,i)=>{if(seen.has(item.id)) ctx.addIssue({code:'custom',path:[i,'id'],message:'Duplicate ID'}); seen.add(item.id);});
}
const boundedBytes=(limit:number)=>z.string().refine(value=>Buffer.byteLength(value,'utf8')<=limit,`Exceeds ${limit} bytes`);
const renderRule=z.object({
  id,
  name:z.string().optional(),
  roles:z.array(z.enum(['user','assistant'])).min(1),
  pattern:z.string().min(1).max(2000),
  flags:z.string().optional(),
  replacement:z.discriminatedUnion('type',[
    z.object({type:z.literal('markdown'),content:boundedBytes(100000)}).strict(),
    z.object({type:z.literal('html'),content:boundedBytes(100000)}).strict(),
    z.object({type:z.literal('component'),component:z.string().regex(/^[$_\p{ID_Start}][$\u200c\u200d_\p{ID_Continue}]*$/u)}).strict(),
  ]),
}).strict().superRefine((rule,ctx)=>{
  const flags=rule.flags??'g';
  if(!/^[gimsu]*$/.test(flags) || new Set(flags).size!==flags.length) {
    ctx.addIssue({code:'custom',path:['flags'],message:'Invalid regular expression flags'});return;
  }
  try {new RegExp(rule.pattern,flags);} catch {ctx.addIssue({code:'custom',path:['pattern'],message:'Invalid regular expression'});}
});
const messageRender=z.object({
  rules:z.array(renderRule).max(100).superRefine(unique).optional(),
  component_source:boundedBytes(1024*1024).refine(value=>value.trim().length>0,'Expected nonempty source').optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.rules?.some(rule=>rule.replacement.type==='component') && !value.component_source)
    ctx.addIssue({code:'custom',path:['component_source'],message:'Component source required'});
});
const schema=z.object({spec:z.literal('world_card'),spec_version:z.literal('0.1'),data:z.object({
  name:id,summary:z.string().optional(),description:z.string().optional(),tags:z.array(id).optional(),cover:z.string().optional(),
  characters:z.array(character).superRefine(unique).refine(items=>items.some(v=>v.player_selectable===true),'Expected a selectable player character'),
  openings:z.array(opening).min(1).superRefine(unique),state:atomicStateSchema.optional(),
  lorebook:z.object({entries:z.array(lore).superRefine(unique)}).optional(),message_render:messageRender.optional(),ui:z.object({type:z.literal('react'),source:z.string().min(1)}).strict().nullable().optional(),extensions:z.custom<Record<string,unknown>>(v=>v!==null && typeof v==='object' && !Array.isArray(v),'Expected extension object').optional()
})});
export class CardError extends Error {
  constructor(readonly path:string,readonly reason:string) {super(path+': '+reason);}
}
function location(parts:PropertyKey[]) {
  return parts.reduce<string>((path,part)=>path+(typeof part==='number'?'['+part+']':'.'+String(part)),'$');
}
export function parseCard(raw:unknown) {
  function depth(value:unknown,n:number):void {
    if(n>64) throw new CardError('$','World exceeds maximum depth');
    if(value && typeof value==='object') for(const child of Object.values(value)) depth(child,n+1);
  }
  depth(raw,0);
  const rawState=(raw as {data?:{state?:unknown}}|null)?.data?.state;
  if(rawState!==undefined && Buffer.byteLength(JSON.stringify(rawState))>1024*1024) throw new CardError('$.data.state','Definition exceeds 1 MiB');
  // Inspect original state keys before object parsers can omit __proto__.
  function checkKeys(value:unknown,path:string):void {
    if(!value || typeof value!=='object') return;
    for(const [name,child] of Object.entries(value)) {
      const next=path+(Array.isArray(value)?'['+name+']':'.'+name);
      if(['__proto__','prototype','constructor'].includes(name)) throw new CardError(next,'Unsafe state key');
      checkKeys(child,next);
    }
  }
  checkKeys(rawState,'$.data.state');
  const openings=(raw as {data?:{openings?:unknown}}|null)?.data?.openings;
  if(Array.isArray(openings)) openings.forEach((item,i)=>checkKeys(item?.initial_state,'$.data.openings['+i+'].initial_state'));
  const parsed=schema.safeParse(raw);
  if(!parsed.success) {
    const issue=parsed.error.issues[0]!;
    throw new CardError(location(issue.path),issue.message);
  }
  const card=parsed.data;
  for(const scopeName of ['global','session','message'] as const) {
    try {initialState(card.data.state,scopeName);} catch(error) {
      const [path,reason]=splitReason(error);
      throw new CardError(path.startsWith(scopeName+'.')?'$.data.state.scopes.'+scopeName+'.'+path.slice(scopeName.length+1):'$.data.state',reason);
    }
  }
  const initial=initialState(card.data.state,'message');
  card.data.openings.forEach((v,i)=>{
    try {applyOpening(card.data.state,initial,v.initial_state);}
    catch(error){const [path,reason]=splitReason(error); throw new CardError('$.data.openings['+i+'].'+path.replace(/^opening\./,''),reason);}
  });
  return card;
}
function splitReason(error:unknown):[string,string] {
  const message=error instanceof Error?error.message:'Invalid data';
  const i=message.indexOf(': ');
  return i<0?['$',message]:[message.slice(0,i),message.slice(i+2)];
}
export function storedError(error:unknown,path='$') {
  const [detail,reason]=splitReason(error);
  return {code:ErrorCodes.WORLD_CORRUPT,details:{path:error instanceof CardError?error.path:detail==='$'?path:detail,reason}};
}
