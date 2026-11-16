import type { Message } from '@earendil-works/pi-ai';
import type { readWorld } from '../../repositories/world-repository.js';
import type { Json } from '../../domain/state/state.js';
import type { PresetNode } from '../../domain/preset/schema.js';
import type { HistoryItem } from './compaction/history.js';
import type { PostprocessPlan } from '../postprocess/contracts.js';
export type World=ReturnType<typeof readWorld>['data'];
export type SourceSnapshot={world:World;views:Record<'global'|'session'|'message',Record<string,Json>>;playerId:string;input:string};
export type CompilationInput=SourceSnapshot&{nodes:readonly PresetNode[];history:readonly HistoryItem[];presetHash:string};
export type PromptTrace={nodeId:string;name:string;role:string;enabled:boolean;messages:Message[]};
export type CompiledContext={messages:Message[];trace:PromptTrace[];activeRoots:readonly string[];postprocess:PostprocessPlan;diagnostics:Array<{id:string;reason:string;path:string}>};
export function assistantMessage(text:string):Message{return {role:'assistant',content:[{type:'text',text}],api:'openai-completions',provider:'sillyrealms',model:'history',usage:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}},stopReason:'stop',timestamp:0};}
