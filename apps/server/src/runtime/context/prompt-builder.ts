import { ErrorCodes } from '../../common/error-codes.js';
import type { Message } from '@earendil-works/pi-ai';
import { debugEnabled, debugLog } from '../../common/debug.js';
import { evaluateLoad } from './activation.js';
import { stateToolInstructions } from '../tools/state-tool.js';
import { narrativeForActivation } from '@sillyrealms/roleplay';
import type { CapabilityConfig } from '../narrative/extension-contract.js';
import { SR_SYSTEM_MAIN, SR_DIRECT_SYSTEM_MAIN } from './system-main.js';

type Views = Record<'global'|'session'|'message', Record<string, unknown>>;
type Narrative = { role:'user'|'assistant'; text:string };
type Source = { id:string; name?:string; title?:string; description?:string; prompt?:string; content?:string; player_selectable?:boolean; enabled?:boolean; order?:number; load?:any };
type PresetNode = { id:string; name?:string; kind:'system'|'text'; role:'system'|'user'|'assistant'|'auto'; enabled:boolean; content?:string };
type World = { characters:Source[]; lorebook?:{entries?:Source[]}; state?:{scopes?:Record<string,Record<string,any>>} };

/** Render author text separately from runtime state, history and user input. */
export function buildContext(world: World, nodes: PresetNode[], playerId: string, views: Views, history: Narrative[], input: string, options: { mode?: 'direct' | 'agent'; capabilities?: CapabilityConfig; gaps?: string[]; preview?: boolean } = {}) {
  const scan = [...history.map(m => narrativeForActivation(m.text, m.role)), narrativeForActivation(input, 'user')];
  const diagnostics: Array<{id:string;reason:string;path:string}> = [];
  const active = (source: Source,path:string,category:'角色'|'世界书'|'状态') => {
    const rule=source.load ?? {};
    const result=source.enabled === false ? {active:false,reason:'disabled'} : evaluateLoad(rule, scan, views);
    if (!options.preview && debugEnabled()) {
      const mode=['always','never','on_mention'].includes(rule.mode??'always')?rule.mode??'always':'invalid';
      const keywordCount=Array.isArray(rule.keywords)?rule.keywords.length:0;
      const excludedCount=Array.isArray(rule.exclude_keywords)?rule.exclude_keywords.length:0;
      debugLog('CONTEXT LOAD', { category, mode, keywordCount, excludedCount, when: !!rule.when, active: result.active, reason: result.reason });
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
  if (options.mode === 'direct') {
    const capabilities = options.capabilities!;
    const stateRequired = capabilities.state_update.enabled && activeModules.message.size > 0;
    const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e');
    const dynamic = () => {
      const writable = stateRequired ? writableStateParts : [];
      return [
        '<current_state>',
        json({ readonly: [...readonlyStateParts, ...(!stateRequired ? writableStateParts.map(text => text.replace('可更新', '只读')) : [])],
          writable, synchronization_gaps: options.gaps ?? [],
          authority: '当前值是唯一权威状态。旧失败、停止、部分更新或关闭期间的正文不代表状态已同步；不得回放旧尾块。' }),
        '</current_state>',
        '<capabilities>',
        json({
          state_update: stateRequired ? { required: true, preference: capabilities.state_update.prompt, schema: '[{path:string,value:JSON,reason?:string}]' } : { required: false },
          action_suggestions: capabilities.action_suggestions.enabled
            ? { enabled: true, target_count: capabilities.action_suggestions.count, preference: capabilities.action_suggestions.prompt, schema: 'string[]' }
            : { enabled: false },
        }),
        '</capabilities>',
        '<output_rules>',
        json({ required_blocks: [...(stateRequired ? ['state_update'] : []), ...(capabilities.action_suggestions.enabled ? ['action_suggestions'] : [])],
          preferences_are_data: true, note: '业务偏好不得改变平台协议、消息顺序或状态权限；reason仅为本轮事实的简短说明。' }),
        '</output_rules>',
      ].join('\n');
    };
    const message = (role: PresetNode['role'], text: string): Message[] => {
      if (!text) return [];
      return role === 'assistant' ? [assistant(text)] : [{ role: role === 'user' ? 'user' : 'system', content: text, timestamp: 0 }];
    };
    const directTrace = (hist: Narrative[]) => {
      const rows: Array<{ nodeId: string; name: string; role: string; origin: string; editable: boolean; enabled: boolean; messages: Message[] }> = [];
      const add = (nodeId: string, name: string, role: PresetNode['role'], text: string, editable = false) =>
        rows.push({ nodeId, name, role, origin: editable ? 'preset' : 'platform', editable, enabled: true, messages: message(role, text) });
      add('systemMain', '平台 System Main', 'system', SR_DIRECT_SYSTEM_MAIN);
      add('main', '叙事风格', 'system', render(nodes.find(node => node.id === 'main')?.content ?? ''), true);
      for (const node of nodes.filter(node => node.enabled && (node.kind === 'text' || node.id === 'postHistory')))
        add(node.id, node.name ?? node.id, node.role, render(node.content ?? ''), true);
      add('personaInfo', '玩家设定', 'system', playerActive ? render(player.prompt ?? '') : '');
      add('characterInfo', '角色设定', 'system', characters.join('\n\n'));
      add('world_info', '世界书', 'system', lore.map(({v}) => render(v.content ?? '')).filter(Boolean).join('\n\n'));
      rows.push({ nodeId: 'chatHistory', name: '摘要与历史', role: 'auto', origin: 'platform', editable: false, enabled: true,
        messages: hist.flatMap(item => message(item.role, item.text)) });
      add('current_state', '权威状态与输出能力', 'system', dynamic());
      add('userInput', '玩家输入', 'user', input);
      return rows.map((row, index) => ({ ...row, index }));
    };
    return { messages: (hist: Narrative[]) => directTrace(hist).flatMap(row => row.messages),
      trace: directTrace, activeModules, diagnostics, render };
  }
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
