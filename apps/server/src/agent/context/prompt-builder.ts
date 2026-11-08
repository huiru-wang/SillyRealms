import { ErrorCodes } from '../../common/error-codes.js';
import type { Message } from '@earendil-works/pi-ai';
import { debugEnabled } from '../../common/debug.js';
import { evaluateLoad } from './activation.js';
import { stateToolInstructions } from '../tools/state-tool.js';

type Views = Record<'global'|'session'|'message', Record<string, unknown>>;
type Narrative = { role:'user'|'assistant'; text:string };
type Source = { id:string; name?:string; title?:string; description?:string; prompt?:string; content?:string; player_selectable?:boolean; enabled?:boolean; order?:number; load?:any };
type PresetNode = { id:string; name?:string; kind:'system'|'text'; role:'system'|'user'|'assistant'|'auto'; enabled:boolean; content?:string };
type World = { characters:Source[]; lorebook?:{entries?:Source[]}; state?:{scopes?:Record<string,Record<string,any>>} };

/** Render author text separately from runtime state, history and user input. */
export function buildContext(world: World, nodes: PresetNode[], playerId: string, views: Views, history: Narrative[], input: string) {
  const scan = [...history.map(m => m.text), input];
  const diagnostics: Array<{id:string;reason:string;path:string}> = [];
  const active = (source: Source,path:string,category:'角色'|'世界书'|'状态') => {
    const rule=source.load ?? {};
    const result=source.enabled === false ? {active:false,reason:'disabled'} : evaluateLoad(rule, scan, views);
    if (debugEnabled()) {
      const mode=rule.mode ?? 'always';
      const condition=mode === 'on_mention' ? `关键词(${rule.keyword_logic ?? 'any'}):${JSON.stringify(rule.keywords ?? [])} 排除:${JSON.stringify(rule.exclude_keywords ?? [])}` : String(mode);
      const quote=(value:unknown)=>JSON.stringify(value);
      console.log(`[加载] ${category} | id=${quote(source.id)} | 条件=${condition} | when=${quote(rule.when ?? null)} | 命中=${result.active ? '是' : '否'} | 原因=${result.reason}`);
    }
    if (result.reason === 'invalid_rule' || result.reason === 'when_evaluation_failed') {
      diagnostics.push({id:source.id,reason:result.reason,path:result.reason==='when_evaluation_failed'?path+'.when':path});
    }
    return result.active;
  };
  const player = world.characters.find(c => c.id === playerId && c.player_selectable);
  if (!player) throw new Error(ErrorCodes.INVALID_PLAYER_CHARACTER);
  const playerActive=active({...player,enabled:true},'$.data.characters['+world.characters.indexOf(player)+'].load','角色');
  const render=(text:string)=>text.replaceAll('{{user}}',()=>player.name?.trim() || 'Default');
  const characters = world.characters.map((v,i) => ({v,i})).filter(({v,i}) => v.id !== playerId && active({...v,enabled:true},'$.data.characters['+i+'].load','角色')).sort((a,b) => (a.v.order ?? 0) - (b.v.order ?? 0) || a.i-b.i).map(({v}) => render(v.prompt ?? '')).filter(Boolean);
  const lore = (world.lorebook?.entries ?? []).map((v,i) => ({v,i})).filter(({v,i}) => active(v,'$.data.lorebook.entries['+i+'].load','世界书')).sort((a,b) => (a.v.load?.order ?? 0) - (b.v.load?.order ?? 0) || a.i-b.i);
  const activeModules: Record<'global'|'session'|'message', Set<string>> = { global:new Set(), session:new Set(), message:new Set() };
  const stateParts:string[] = [];
  for (const scope of ['global','session','message'] as const) {
    const fields = world.state?.scopes?.[scope] ?? {};
    for (const [name, def] of Object.entries(fields)) {
      const source = { id:`${scope}:${name}`, load:def.load };
      if (active(source,'$.data.state.scopes.'+scope+'.'+name+'.load','状态')) {
        activeModules[scope].add(name);
        const limits=[def.min!==undefined?`最小值 ${def.min}`:'',def.max!==undefined?`最大值 ${def.max}`:''].filter(Boolean).join('，');
        stateParts.push([`${name}（${scope === 'message' ? '可更新' : '只读'}；${scope}；${def.type}${limits ? '；'+limits : ''}）`,typeof def.description==='string'?render(def.description):'',`当前值：${JSON.stringify(views[scope][name])}`].filter(Boolean).join('\n'));
      }
    }
  }
  const build = (n:PresetNode, hist:Narrative[]): Message[] => {
    if (n.id === 'chatHistory') return hist.map(item => item.role === 'user' ? {role:'user',content:item.text,timestamp:Date.now()} : assistant(item.text));
    const before = lore.filter(({v}) => (v.load?.anchor ?? 'characterInfo') === n.id && (v.load?.position ?? 'after') === 'before').map(({v}) => render(v.content ?? ''));
    const after = lore.filter(({v}) => (v.load?.anchor ?? 'characterInfo') === n.id && (v.load?.position ?? 'after') === 'after').map(({v}) => render(v.content ?? ''));
    let body = '';
    if (n.id !== 'postHistory' || n.enabled) {
      if (n.id === 'personaInfo') body = playerActive ? render(player.prompt ?? '') : '';
      else if (n.id === 'characterInfo') body = characters.join('\n\n');
      else if (n.id === 'worldState') {
        const modules=world.state?.scopes?.message??{};
        const intro=activeModules.message.size ? stateToolInstructions(modules,activeModules.message,render,false) : '当前状态仅供读取；没有可用的消息状态更新工具。';
        body=[intro,...stateParts].join('\n');
      }
      else if (n.id === 'userInput') body = input;
      else body = render(n.content ?? '');
    }
    const text = [...before, body, ...after].filter(Boolean).join('\n\n');
    if (!text) return [];
    if (n.role === 'user') return [{role:'user',content:text,timestamp:Date.now()}];
    if (n.role === 'assistant') return [assistant(text)];
    return [{role:'system',content:text,timestamp:Date.now()}];
  };
  return { messages: (hist:Narrative[]) => nodes.flatMap(node => build(node,hist)), trace:(hist:Narrative[])=>nodes.map((node,index)=>({index,nodeId:node.id,name:node.name ?? node.id,enabled:node.id !== 'postHistory' || node.enabled,role:node.role,messages:build(node,hist)})), activeModules, diagnostics, render };
}
function assistant(text:string): Message {
  return { role:'assistant', content:[{type:'text',text}], api:'openai-completions', provider:'sillyrealms', model:'history', usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason:'stop', timestamp:Date.now() };
}
/** Conservative UTF-8 byte count with per-message and tool overhead. */
export function estimateTokens(messages: Message[], toolJson = ''): number {
  return messages.reduce((sum,m) => sum + Buffer.byteLength(JSON.stringify(m),'utf8') + 16, Buffer.byteLength(toolJson,'utf8'));
}
