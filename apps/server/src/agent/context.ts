import type { Message } from '@earendil-works/pi-ai';
import { evaluateLoad } from './activation.js';

type Views = Record<'global'|'session'|'message', Record<string, unknown>>;
type Narrative = { role:'user'|'assistant'; text:string };
type Source = { id:string; name?:string; description?:string; content?:string; player_selectable?:boolean; enabled?:boolean; order?:number; load?:any };
type PresetNode = { id:string; kind:'system'|'text'; role:'system'|'user'|'assistant'|'auto'; enabled:boolean; content?:string };
type World = { characters:Source[]; lorebook?:{entries?:Source[]}; state?:{scopes?:Record<string,{modules?:Record<string,any>}>} };

/** Build non-history prompt once; all author strings remain literal. */
export function buildContext(world: World, nodes: PresetNode[], playerId: string, views: Views, history: Narrative[], input: string) {
  const scan = [...history.map(m => m.text), input];
  const diagnostics: Array<{id:string;reason:string}> = [];
  const active = (source: Source) => {
    if (source.enabled === false) return false;
    const result = evaluateLoad(source.load, scan, views);
    if (result.reason === 'invalid_rule') diagnostics.push({ id:source.id, reason:result.reason });
    return result.active;
  };
  const player = world.characters.find(c => c.id === playerId && c.player_selectable);
  if (!player) throw new Error('INVALID_PLAYER_CHARACTER');
  const characters = world.characters.map((v,i) => ({v,i})).filter(({v}) => v.id !== playerId && active(v)).sort((a,b) => (a.v.order ?? 0) - (b.v.order ?? 0) || a.i-b.i).map(({v}) => v.description ?? '').filter(Boolean);
  const lore = (world.lorebook?.entries ?? []).map((v,i) => ({v,i})).filter(({v}) => active(v)).sort((a,b) => (a.v.load?.order ?? 0) - (b.v.load?.order ?? 0) || a.i-b.i);
  const activeModules: Record<'global'|'session'|'message', Set<string>> = { global:new Set(), session:new Set(), message:new Set() };
  const stateParts:string[] = [];
  for (const scope of ['global','session','message'] as const) {
    const modules = world.state?.scopes?.[scope]?.modules ?? {};
    for (const [name, def] of Object.entries(modules)) {
      const source = { id:`${scope}:${name}`, load:def.load };
      if (active(source)) { activeModules[scope].add(name); stateParts.push(JSON.stringify({scope, name, description: def.description ?? '', value:views[scope][name]})); }
    }
  }
  const build = (n:PresetNode, hist:Narrative[]): Message[] => {
    if (n.id === 'chatHistory') return hist.map(item => item.role === 'user' ? {role:'user',content:item.text,timestamp:Date.now()} : assistant(item.text));
    const before = lore.filter(({v}) => (v.load?.anchor ?? 'characterInfo') === n.id && (v.load?.position ?? 'after') === 'before').map(({v}) => v.content ?? '');
    const after = lore.filter(({v}) => (v.load?.anchor ?? 'characterInfo') === n.id && (v.load?.position ?? 'after') === 'after').map(({v}) => v.content ?? '');
    let body = '';
    if (n.enabled) {
      if (n.id === 'personaInfo') body = player.description ?? '';
      else if (n.id === 'characterInfo') body = characters.join('\n\n');
      else if (n.id === 'worldState') body = stateParts.join('\n');
      else if (n.id === 'userInput') body = input;
      else body = n.content ?? '';
    }
    const text = [...before, body, ...after].filter(Boolean).join('\n\n');
    if (!text) return [];
    if (n.role === 'user') return [{role:'user',content:text,timestamp:Date.now()}];
    if (n.role === 'assistant') return [assistant(text)];
    return [{role:'system',content:text,timestamp:Date.now()}];
  };
  return { messages: (hist:Narrative[]) => nodes.flatMap(node => build(node,hist)), activeModules, diagnostics };
}
function assistant(text:string): Message {
  return { role:'assistant', content:[{type:'text',text}], api:'openai-completions', provider:'sillyrealms', model:'history', usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason:'stop', timestamp:Date.now() };
}
/** Conservative UTF-8 byte count with per-message and tool overhead. */
export function estimateTokens(messages: Message[], toolJson = ''): number {
  return messages.reduce((sum,m) => sum + Buffer.byteLength(JSON.stringify(m),'utf8') + 16, Buffer.byteLength(toolJson,'utf8'));
}
