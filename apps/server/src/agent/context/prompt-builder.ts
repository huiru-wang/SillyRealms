import { ErrorCodes } from '../../common/error-codes.js';
import type { Message } from '@earendil-works/pi-ai';
import { debugEnabled } from '../../common/debug.js';
import { evaluateLoad } from './activation.js';
import { stateToolInstructions } from '../tools/state-tool.js';
import { narrativeForActivation } from '@sillyrealms/roleplay';
import { SR_SYSTEM_MAIN } from './system-main.js';

type Views = Record<'global'|'session'|'message', Record<string, unknown>>;
type Narrative = { role:'user'|'assistant'; text:string };
type Source = { id:string; name?:string; title?:string; description?:string; prompt?:string; content?:string; player_selectable?:boolean; enabled?:boolean; order?:number; load?:any };
type PresetNode = { id:string; name?:string; kind:'system'|'text'; role:'system'|'user'|'assistant'|'auto'; enabled:boolean; content?:string };
type World = { characters:Source[]; lorebook?:{entries?:Source[]}; state?:{scopes?:Record<string,Record<string,any>>} };

/** Render author text separately from runtime state, history and user input. */
export function buildContext(world: World, nodes: PresetNode[], playerId: string, views: Views, history: Narrative[], input: string) {
  const scan = [...history.map(m => narrativeForActivation(m.text, m.role)), narrativeForActivation(input, 'user')];
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
  const readonlyStateParts:string[] = [];
  const writableStateParts:string[] = [];
  for (const scope of ['global','session','message'] as const) {
    const fields = world.state?.scopes?.[scope] ?? {};
    for (const [name, def] of Object.entries(fields)) {
      const source = { id:`${scope}:${name}`, load:def.load };
      if (active(source,'$.data.state.scopes.'+scope+'.'+name+'.load','状态')) {
        activeModules[scope].add(name);
        const limits=[def.min!==undefined?`最小值 ${def.min}`:'',def.max!==undefined?`最大值 ${def.max}`:''].filter(Boolean).join('，');
        const record = [`${name}（${scope === 'message' ? '可更新' : '只读'}；${scope}；${def.type}${limits ? '；'+limits : ''}）`,typeof def.description==='string'?render(def.description):'',`当前值：${JSON.stringify(views[scope][name])}`].filter(Boolean).join('\n');
        if (scope === 'message') writableStateParts.push(record);
        else readonlyStateParts.push(record);
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
        const writable = activeModules.message.size > 0;
        body = [
          ...(writable ? [stateToolInstructions(), `【可更新状态】\n${writableStateParts.join('\n\n')}`]
            : ['当前不存在激活的可写 message 状态，不提供状态更新工具。']),
          ...(readonlyStateParts.length ? [`【只读状态】\n${readonlyStateParts.join('\n\n')}`] : []),
        ].join('\n\n');
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
  const systemMain = (): Message => ({role:'system',content:SR_SYSTEM_MAIN,timestamp:Date.now()});
  return { messages: (hist:Narrative[]) => [systemMain(), ...nodes.flatMap(node => build(node,hist))], trace:(hist:Narrative[])=>[{index:0,nodeId:'systemMain',name:'平台 System Main',enabled:true,role:'system',origin:'platform',editable:false,messages:[systemMain()]}, ...nodes.map((node,index)=>({index:index+1,nodeId:node.id,name:node.name ?? node.id,enabled:node.id !== 'postHistory' || node.enabled,role:node.role,origin:'preset',editable:true,messages:build(node,hist)}))], activeModules, diagnostics, render };
}
function assistant(text:string): Message {
  return { role:'assistant', content:[{type:'text',text}], api:'openai-completions', provider:'sillyrealms', model:'history', usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason:'stop', timestamp:Date.now() };
}
/** Conservative UTF-8 byte count with per-message and tool overhead. */
export function estimateMessageBytes(messages: Message[], toolJson = ''): number {
  return messages.reduce((sum,m) => sum + Buffer.byteLength(JSON.stringify(m),'utf8') + 16, Buffer.byteLength(toolJson,'utf8'));
}

/** Structural size estimate only; not a provider tokenizer or billable Token count. */
export function estimateNarrativeItemSize(item: Narrative): number {
  const message: Message = item.role === 'user'
    ? { role:'user', content:item.text, timestamp:0 }
    : assistant(item.text);
  return Buffer.byteLength(JSON.stringify(message), 'utf8') + 16;
}
