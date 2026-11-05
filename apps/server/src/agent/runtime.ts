import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Api, AssistantMessage, Context, Message, Model, ToolResultMessage } from '@earendil-works/pi-ai';
import type { CredentialStore } from '../infrastructure/credentials/store.js';
import { buildContext, estimateTokens } from './context.js';
import { compressHistory, type HistoryItem } from './summary.js';
import { setState, stateTool } from './state-tool.js';
import type { ModelGateway } from './gateway.js';
import { readAncestors } from '../domain/session/ancestors.js';
import { decodeMessageState, validateSnapshot, type Json } from '../domain/state/state.js';

type Task = { runId:string; requestId:string; controller:AbortController; done:Promise<void>; finish:()=>void; stopped:boolean; drain?:()=>void };
type Row = Record<string, any>;
const tool = stateTool;
/** Stop waiting for a provider that ignores abort; late values are never applied. */
async function* untilAborted<T>(source:AsyncIterable<T>, signal:AbortSignal):AsyncGenerator<T> {
  const iterator=source[Symbol.asyncIterator](); const marker=Symbol('aborted');
  let wake!:()=>void; const aborted=new Promise<typeof marker>(resolve => { wake=()=>resolve(marker); });
  signal.addEventListener('abort',wake,{once:true}); if (signal.aborted) wake();
  try {
    while (true) {
      const result=await Promise.race([iterator.next(),aborted]);
      if (result === marker || result.done) return;
      yield result.value;
    }
  } finally {
    signal.removeEventListener('abort',wake);
    if (signal.aborted && iterator.return) void Promise.resolve(iterator.return()).catch(()=>{});
  }
}

export class RuntimeError extends Error { constructor(public code:string, public details?:Record<string,string>) { super(code); } }

export class AgentRuntime {
  private active = new Map<string,Task>();
  private deleting = new Set<string>();
  private deletingWorlds = new Set<string>();
  constructor(private db:DatabaseSync, private credentials:CredentialStore, private gateway:ModelGateway) {}
  busy(sessionId:string) { return this.active.has(sessionId) || this.deleting.has(sessionId); }
  worldDeleting(id:string) { return this.deletingWorlds.has(id); }
  async deleteWorld<T>(worldId:string, ids:()=>string[], remove:()=>T):Promise<T> {
    if (this.deletingWorlds.has(worldId)) throw new RuntimeError('WORLD_BUSY');
    this.deletingWorlds.add(worldId);
    try { return await this.deleteSessions(ids(),remove); } finally { this.deletingWorlds.delete(worldId); }
  }
  async deleteSessions<T>(sessionIds:string[], remove:()=>T):Promise<T> {
    if (sessionIds.some(id=>this.deleting.has(id))) throw new RuntimeError('SESSION_BUSY');
    for (const id of sessionIds) this.deleting.add(id);
    try {
      for (const id of sessionIds) { const task=this.active.get(id); if (task) await this.stop(id,task.runId); }
      return remove();
    } finally { for (const id of sessionIds) this.deleting.delete(id); }
  }
  async stop(sessionId:string, runId:string) {
    const task = this.active.get(sessionId);
    if (task?.runId === runId) { task.stopped = true; task.controller.abort(); await task.done; return this.status(sessionId,runId) ?? {runId,status:'stopped',tipEntryId:this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId)?.tip_entry_id ?? null}; }
    return this.status(sessionId,runId);
  }
  async stopActive(sessionId:string) { const task=this.active.get(sessionId); return task ? this.stop(sessionId,task.runId) : null; }
  status(sessionId:string, runId:string) {
    const rows = this.db.prepare('SELECT ext_data FROM entries WHERE session_id=? AND run_id=? AND role=? ORDER BY seq ASC').all(sessionId,runId,'user');
    if (rows.length) return {...JSON.parse(String(rows[0]!.ext_data)).run,tipEntryId:this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId)?.tip_entry_id ?? null};
    const task = this.active.get(sessionId); return task?.runId === runId ? {status:'preparing'} : null;
  }
  async prepare(sessionId:string, input:string, requestId:string, expectedTip:string, clientSignal?:AbortSignal):Promise<{runId:string;stream:ReadableStream<Uint8Array>}> {
    if (this.deleting.has(sessionId)) throw new RuntimeError('SESSION_BUSY');
    const running = this.active.get(sessionId);
    if (running) { if (running.requestId === requestId) throw new RuntimeError('REQUEST_ALREADY_EXISTS',{runId:running.runId}); throw new RuntimeError('SESSION_BUSY'); }
    const runId = randomUUID(), controller = new AbortController(); let finish!:()=>void;
    const done = new Promise<void>(resolve => { finish=resolve; });
    const task:Task = {runId,requestId,controller,done,finish,stopped:false}; this.active.set(sessionId,task);
    const disconnected=()=>{task.stopped=true;controller.abort();task.drain?.();};
    clientSignal?.addEventListener('abort',disconnected,{once:true});
    if (clientSignal?.aborted) disconnected();
    const originalFinish=task.finish;
    task.finish=()=>{clientSignal?.removeEventListener('abort',disconnected);originalFinish();};
    try {
      if (task.stopped) throw new RuntimeError('RUN_STOPPED');
      const session = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId) as Row | undefined;
      if (!session) throw new RuntimeError('SESSION_NOT_FOUND');
      const duplicate = this.db.prepare("SELECT run_id FROM entries WHERE session_id=? AND role='user' AND json_extract(ext_data,'$.requestId')=?").get(sessionId,requestId);
      if (duplicate) throw new RuntimeError('REQUEST_ALREADY_EXISTS',{runId:String(duplicate.run_id)});
      if (session.tip_entry_id !== expectedTip) throw new RuntimeError('TIP_CONFLICT');
      if (!session.preset_id) throw new RuntimeError('PRESET_NOT_SELECTED');
      const presetRow = this.db.prepare('SELECT config_json FROM presets WHERE id=?').get(session.preset_id);
      if (!presetRow) throw new RuntimeError('PRESET_NOT_FOUND');
      const preset = JSON.parse(String(presetRow.config_json));
      const config = this.db.prepare('SELECT * FROM api_model_configs WHERE id=?').get(preset.api_model_config_id) as Row | undefined;
      if (!config) throw new RuntimeError('API_MODEL_CONFIG_NOT_FOUND');
      const key = await this.credentials.get(config.credential_ref);
      if (!key) throw new RuntimeError('CREDENTIAL_NOT_CONFIGURED');
      const model = this.gateway.resolve(config.provider_id,config.model_id);
      if (!model) throw new RuntimeError('MODEL_NOT_FOUND');
      const worldRow = this.db.prepare('SELECT * FROM worlds WHERE id=?').get(session.world_id) as Row | undefined;
      if (!worldRow) throw new RuntimeError('WORLD_NOT_FOUND');
      const world = JSON.parse(worldRow.data_json).data;
      const chain = this.ancestors(sessionId,session.tip_entry_id);
      const stateRow = [...chain].reverse().find(r=>r.state !== null);
      let messageState:Record<string,Json>;
      try { messageState=decodeMessageState(stateRow?.state ?? '[]'); } catch { throw new RuntimeError('STATE_SCHEMA_CONFLICT'); }
      const views = { global:JSON.parse(worldRow.state), session:JSON.parse(session.state), message:structuredClone(messageState) };
      try { for (const scope of ['global','session','message'] as const) validateSnapshot(world.state,scope,views[scope]); } catch { throw new RuntimeError('STATE_SCHEMA_CONFLICT'); }
      const oldSummaryRow = [...chain].reverse().find(r=>r.type === 'compaction' && JSON.parse(r.ext_data).summary?.kind === 'sillyrealms.summary');
      const summaryExt = oldSummaryRow ? JSON.parse(oldSummaryRow.ext_data).summary : undefined;
      const summaryIndex = summaryExt ? chain.findIndex(r=>r.id === summaryExt.coveredThroughEntryId) : -1;
      if (summaryExt && (summaryIndex < 0 || summaryIndex >= chain.indexOf(oldSummaryRow!) || this.narrative(chain[summaryIndex]!).length === 0)) throw new RuntimeError('INVALID_SUMMARY_BOUNDARY');
      const history = chain.slice(summaryIndex+1).flatMap(row => this.narrative(row));
      const previousSummary = summaryExt ? {text:JSON.parse(oldSummaryRow!.payload).summary as string, coveredThroughEntryId:summaryExt.coveredThroughEntryId as string} : undefined;
      const candidateHistory = [...(previousSummary ? [{role:'assistant' as const,text:previousSummary.text}] : []), ...history];
      const context = buildContext(world,preset.nodes,session.user_character_id,views,candidateHistory,input);
      const modules = world.state?.scopes?.message?.modules ?? {};
      const useTool = context.activeModules.message.size > 0;
      if (useTool && !this.gateway.toolVerified(config.provider_id,config.model_id)) throw new RuntimeError('MODEL_TOOL_UNSUPPORTED');
      const tools = useTool ? [tool] : [];
      const output = preset.budget.max_output_tokens;
      const budget = Math.min(preset.budget.max_context_tokens ?? model.contextWindow, model.contextWindow) - output - 1024;
      if (!Number.isFinite(budget) || budget <= 0 || output > model.maxTokens || estimateTokens(context.messages([]),JSON.stringify(tools)) > budget) throw new RuntimeError('CONTEXT_BUDGET_EXCEEDED');
      const summaryGeneration:Array<{request:unknown;response:string}> = [];
      const compressed = await compressHistory({ history, oldSummary:previousSummary, budget, build:context.messages, toolJson:JSON.stringify(tools), summarize:async request => {
        let previous = request.previous;
        const source = request.chunks.map(item => ({ item, chars:Array.from(item.text), offset:0 }));
        let index = 0;
        while (index < source.length) {
          const batch:Array<{sourceEntryId:string;start:number;end:number;role:string;text:string}> = [];
          const makeMessages = (pieces:typeof batch):Message[] => [{role:'system',content:preset.summary_prompt,timestamp:Date.now()},{role:'user',content:JSON.stringify({previous,messages:pieces.map(p=>({role:p.role,text:p.text}))}),timestamp:Date.now()}];
          while (index < source.length) {
            const part = source[index]!;
            let low=part.offset+1, high=part.chars.length, fit=part.offset;
            while (low <= high) {
              const mid=Math.floor((low+high)/2);
              const candidate={sourceEntryId:part.item.id,start:part.offset,end:mid,role:part.item.role,text:part.chars.slice(part.offset,mid).join('')};
              if (estimateTokens(makeMessages([...batch,candidate])) <= budget) { fit=mid; low=mid+1; } else high=mid-1;
            }
            if (fit === part.offset) break;
            batch.push({sourceEntryId:part.item.id,start:part.offset,end:fit,role:part.item.role,text:part.chars.slice(part.offset,fit).join('')});
            part.offset=fit;
            if (part.offset === part.chars.length) index++;
            else break;
          }
          if (!batch.length) throw new RuntimeError('CONTEXT_BUDGET_EXCEEDED');
          const messages=makeMessages(batch); let text=''; let ended=false;
          for await (const event of untilAborted(this.gateway.stream(model,{messages},{apiKey:key,signal:controller.signal,maxTokens:output,temperature:preset.model_parameters?.temperature}),controller.signal)) {
            if (event.type === 'text_delta') text += event.delta;
            if (event.type === 'done') ended = true;
            if (event.type === 'error') throw new RuntimeError('SUMMARY_FAILED');
          }
          if (!ended || !text.trim()) throw new RuntimeError('SUMMARY_FAILED');
          summaryGeneration.push({request:{previous,chunks:batch},response:text}); previous=text;
        }
        if (!previous) throw new RuntimeError('SUMMARY_FAILED');
        return previous;
      } });
      if (task.stopped) throw new RuntimeError('RUN_STOPPED');
      const messages = context.messages(compressed.history);
      let tip:string = session.tip_entry_id;
      const userId = randomUUID();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const latest = this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId);
        if (latest?.tip_entry_id !== tip) throw new RuntimeError('TIP_CONFLICT');
        if (compressed.summary) tip = this.append(sessionId,tip,runId,'compaction',null,{summary:compressed.summary.text},{summary:{kind:'sillyrealms.summary',coveredThroughEntryId:compressed.summary.coveredThroughEntryId,generation:summaryGeneration}});
        this.append(sessionId,tip,runId,'message','user',{message:{role:'user',content:input,timestamp:Date.now()}},{requestId,run:{runId,status:'running',diagnostics:context.diagnostics}},userId);
        this.db.exec('COMMIT');
      } catch (err) { this.db.exec('ROLLBACK'); throw err; }
      const stream = new ReadableStream<Uint8Array>({
        start: streamController => { void this.execute({sessionId,runId,userId,model,key,messages,tools,modules,worldState:world.state,active:context.activeModules.message,workspace:views.message,output,temperature:preset.model_parameters?.temperature,task,streamController}); },
        pull: () => { task.drain?.(); },
        cancel: () => { task.stopped = true; task.controller.abort(); task.drain?.(); },
      });
      return {runId,stream};
    } catch (err) { this.active.delete(sessionId); task.finish(); if (task.stopped) throw new RuntimeError('RUN_STOPPED'); throw err; }
  }
  private ancestors(sessionId:string,tip:string):Row[] {
    try { return readAncestors(this.db,sessionId,tip); } catch { throw new RuntimeError('INVALID_PARENT_CHAIN'); }
  }
  private narrative(row:Row):HistoryItem[] {
    if (row.type !== 'message' || !['user','assistant'].includes(row.role)) return [];
    const ext = JSON.parse(row.ext_data); if (ext.nonNarrative) return [];
    const message = JSON.parse(row.payload).message;
    if (!message || message.role !== row.role) throw new RuntimeError('ENTRY_ROLE_MISMATCH');
    const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter((p:{type:string})=>p.type === 'text').map((p:{text:string})=>p.text).join('') : '';
    return text ? [{id:row.id,role:row.role,text}] : [];
  }
  private append(sessionId:string,parentId:string,runId:string,type:string,role:string|null,payload:object,ext:object,id = randomUUID()):string {
    const session = this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId);
    if (!session || session.tip_entry_id !== parentId) throw new RuntimeError('TIP_CONFLICT');
    const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM entries WHERE session_id=?').get(sessionId)?.seq);
    const visible = type === 'message' && (role === 'user' || role === 'assistant') && this.narrative({id,type,role,payload:JSON.stringify(payload),ext_data:JSON.stringify(ext)}).length > 0;
    if (visible) {
      const previous = [...this.ancestors(sessionId,parentId)].reverse().find(r=>this.narrative(r).length > 0);
      if (previous) this.db.prepare('UPDATE entries SET branch_count=1 WHERE id=?').run(previous.id);
    }
    this.db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)').run(id,sessionId,parentId,runId,seq,type,role,0,Date.now(),JSON.stringify(payload),JSON.stringify(ext));
    this.db.prepare('UPDATE sessions SET tip_entry_id=?,updated_at=? WHERE id=?').run(id,Date.now(),sessionId);
    return id;
  }
  private appendAtomic(sessionId:string,parentId:string,runId:string,type:string,role:string|null,payload:object,ext:object):string {
    this.db.exec('BEGIN IMMEDIATE');
    try { const id = this.append(sessionId,parentId,runId,type,role,payload,ext); this.db.exec('COMMIT'); return id; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  private async execute(args:{sessionId:string;runId:string;userId:string;model:Model<Api>;key:string;messages:Message[];tools:Context['tools'];modules:Record<string,any>;worldState:unknown;active:Set<string>;workspace:Record<string,Json>;output:number;temperature?:number;task:Task;streamController:ReadableStreamDefaultController<Uint8Array>}) {
    const {sessionId,runId,userId,model,key,messages,tools,modules,worldState,active,workspace,output,temperature,task,streamController} = args;
    let outcome:'completed'|'stopped'|'failed' = 'completed';
    let partialId:string | null = null; let partialText = ''; let pendingHigh = '';
    const writeText = async (text:string) => {
      if (!text || task.stopped) return;
      partialText += text;
      if (!partialId) {
        const tip = String(this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId)?.tip_entry_id);
        partialId = this.appendAtomic(sessionId,tip,runId,'message','assistant',{message:{role:'assistant',content:[{type:'text',text:partialText}],timestamp:Date.now()}},{origin:'stream_partial',status:'streaming'});
      } else {
        const row = this.db.prepare('SELECT payload FROM entries WHERE id=?').get(partialId)!;
        const payload = JSON.parse(String(row.payload)); payload.message.content[0].text = partialText;
        this.db.prepare('UPDATE entries SET payload=? WHERE id=?').run(JSON.stringify(payload),partialId);
      }
      streamController.enqueue(new TextEncoder().encode(text));
      if (streamController.desiredSize !== null && streamController.desiredSize <= 0 && !task.stopped) await new Promise<void>(resolve => {
        const wake = () => { task.drain = undefined; task.controller.signal.removeEventListener('abort',wake); resolve(); };
        task.drain = wake; task.controller.signal.addEventListener('abort',wake,{once:true});
        if (task.controller.signal.aborted) wake();
      });
    };
    try {
      for (let turn=0; turn<32; turn++) {
        partialId = null; partialText = ''; pendingHigh = ''; let final:AssistantMessage | undefined;
        for await (const event of untilAborted(this.gateway.stream(model,{messages,tools},{apiKey:key,signal:task.controller.signal,maxTokens:output,temperature}),task.controller.signal)) {
          if (task.stopped) break;
          if (event.type === 'text_delta' && event.delta) {
            let chunk=pendingHigh+event.delta; pendingHigh='';
            const last=chunk.charCodeAt(chunk.length-1);
            if (last >= 0xd800 && last <= 0xdbff) { pendingHigh=chunk.slice(-1); chunk=chunk.slice(0,-1); }
            // Normalize unmatched surrogates exactly as the UTF-8 encoder will.
            await writeText(new TextDecoder().decode(new TextEncoder().encode(chunk)));
          } else if (event.type === 'done') {
            if (pendingHigh) { await writeText('\uFFFD'); pendingHigh=''; }
            final = event.message;
          }
          else if (event.type === 'error') { if (!task.stopped) throw new RuntimeError('PROVIDER_ERROR'); }
        }
        if (task.stopped) { outcome='stopped'; break; }
        if (!final) throw new RuntimeError('PROVIDER_ERROR');
        const finalText = final.content.filter(p=>p.type === 'text').map(p=>p.text).join('');
        const rawExt = {origin:'pi',status:'completed'};
        if (partialId && finalText === partialText) this.db.prepare('UPDATE entries SET payload=?,ext_data=? WHERE id=?').run(JSON.stringify({message:final}),JSON.stringify(rawExt),partialId);
        else {
          const tip = String(this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId)?.tip_entry_id);
          this.appendAtomic(sessionId,tip,runId,'message','assistant',{message:final},partialId ? {...rawExt,nonNarrative:true} : rawExt);
        }
        messages.push(final);
        const calls = final.content.filter(p=>p.type === 'toolCall');
        if (!calls.length) break;
        for (const call of calls) {
          if (task.stopped) break;
          let result:object;
          try {
            if (call.name !== 'set_state' || call.argumentsError || !(typeof call.arguments.path === 'string' || Array.isArray(call.arguments.path))) throw new Error('INVALID_TOOL_CALL');
            setState(workspace,modules,active,call.arguments.path as string|string[],call.arguments.value);
            result = {ok:true};
          } catch { result = {ok:false,code:'INVALID_STATE_UPDATE'}; }
          const toolResult:ToolResultMessage = {role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:JSON.stringify(result)}],isError:!(result as {ok:boolean}).ok,timestamp:Date.now()};
          const tip = String(this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId)?.tip_entry_id);
          this.appendAtomic(sessionId,tip,runId,'message','toolResult',{message:toolResult},{});
          messages.push(toolResult);
        }
        if (task.stopped) { outcome='stopped'; break; }
        if (turn === 31) throw new RuntimeError('TOOL_LIMIT_EXCEEDED');
      }
    } catch { outcome = task.stopped ? 'stopped' : 'failed'; }
    try {
      if (outcome !== 'failed') validateSnapshot(worldState,'message',workspace);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (partialId && outcome !== 'completed') {
          const row = this.db.prepare('SELECT ext_data FROM entries WHERE id=?').get(partialId);
          if (row) this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(JSON.stringify({...JSON.parse(String(row.ext_data)),status:outcome}),partialId);
        }
        const user = this.db.prepare('SELECT ext_data FROM entries WHERE id=?').get(userId);
        if (!user) throw new Error('RUN_NOT_FOUND');
        const ext = JSON.parse(String(user.ext_data)); ext.run.status = outcome;
        this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(JSON.stringify(ext),userId);
        if (outcome !== 'failed') {
          const tip = this.db.prepare('SELECT tip_entry_id FROM sessions WHERE id=?').get(sessionId)?.tip_entry_id;
          this.db.prepare('UPDATE entries SET state=? WHERE id=?').run(JSON.stringify(Object.entries(workspace).map(([key,value])=>({key,value}))),String(tip));
        }
        this.db.exec('COMMIT');
      } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    } catch {
      outcome = 'failed';
      try { const row = this.db.prepare('SELECT ext_data FROM entries WHERE id=?').get(userId); if (row) { const ext = JSON.parse(String(row.ext_data)); ext.run.status='failed'; ext.run.error='STATE_COMMIT_FAILED'; this.db.prepare('UPDATE entries SET ext_data=? WHERE id=?').run(JSON.stringify(ext),userId); } } catch { /* database unavailable; recover as interrupted on restart */ }
    }
    try { streamController.close(); } catch { /* consumer already disconnected */ }
    this.active.delete(sessionId); task.finish();
  }
}
