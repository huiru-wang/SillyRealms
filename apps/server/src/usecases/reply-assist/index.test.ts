import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { bindTransaction } from '../../infrastructure/database/transaction.js';
import { EventHub, type SessionEvent } from '../../infrastructure/events/event-hub.js';
import type { ModelClient, ModelInfo } from '../../infrastructure/model/client.js';
import { createServices } from '../../services.js';
import { createUsecases } from '../../usecases.js';
import { createApp } from '../../app.js';
import { memoryCredentials } from '../../testing/credentials.js';

const model: ModelInfo = { providerId:'test', modelId:'writer', name:'Writer', api:'test', input:['text'],
  contextWindow:8192, maxTokens:1024, narrativeCompatible:true, supportsMidConversationSystemMessages:true,
  reasoning:false, thinkingLevelMap:null, thinkingLevels:['off'], promptCache:null };
const makeFixture = async () => {
  const db=openDatabase(':memory:'), events=new EventHub();
  const services=createServices(db, '.', memoryCredentials());
  const stream=vi.fn<ModelClient['stream']>(async function*(){
    yield { type:'request_started' };
    yield { type:'delta', delta:{content:'partial',reasoning_content:'private'} };
    yield { type:'done', finishReason:'stop', usage:null, snapshot:{role:'assistant',content:'new draft',reasoning_content:'private',tool_calls:[]} };
  });
  const usecases=createUsecases({services,events,transaction:bindTransaction(db),modelClient:{
    resolve:()=>model,assertMessageOrder:()=>{},listProviders:()=>[],stream,
  }});
  services.presets.ensureBuiltins();
  const presetId=services.presets.defaultReplyAssistId!;
  const credentialRef=services.credentials.referenceFor('model');
  await services.credentials.set(credentialRef,'test-only');
  services.models.create({id:'model',name:'Model',providerId:'test',modelId:'writer',credentialRef});
  services.settings.ensure({ defaultPresetId:'sr-default-preset', defaultApiModelConfigId:null, defaultReplyAssistPresetId:presetId });
  services.worlds.create({id:'world',name:'World',specVersion:'0.1',characters:[{id:'p',name:'Player',player_selectable:true}],
    openings:[{id:'open',name:'Open',content:'Opening'}]});
  for (const id of ['a','b']) services.sessions.create({id,worldId:'world',userCharacterId:'p',runtimeConfig: { narrativePresetId: 'sr-default-preset', apiModelConfigId: 'model' }});
  const seen:SessionEvent[]=[];
  events.subscribe('a',event=>seen.push(event));
  const app=createApp({services,usecases,events});
  const submit=(id='a',draftText='')=>usecases.replyAssist.submit(id,{requestId:randomUUID(),draftText});
  const bind=()=>services.presets.update(presetId,{apiModelConfigId:'model'});
  return {db,services,usecases,events,app,presetId,seen,stream,submit,bind};
};
describe('AI reply assist',()=>{
  let f:Awaited<ReturnType<typeof makeFixture>>;
  beforeEach(async()=>{f=await makeFixture();});
  afterEach(async()=>{await f.app.shutdown();f.db.close();});
  it('prioritizes session conflicts over missing configuration and releases rejected requests without events',async()=>{
    f.services.settings.update({defaultReplyAssistPresetId:null});
    const owner=f.services.cache.acquireRun({sessionId:'a',worldId:'world',runId:'n'});
    const response=await f.app.request('/api/v1/sessions/a/reply-assist',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({requestId:randomUUID(),draftText:'original'})});
    expect(response.status).toBe(409);expect((await response.json()).errorCode).toBe('RUN_ALREADY_ACTIVE');
    f.services.cache.releaseRun(owner);
    expect(()=>f.submit()).toThrow('REPLY_ASSIST_NOT_CONFIGURED');
    f.services.settings.update({defaultReplyAssistPresetId:f.presetId});
    expect(()=>f.submit()).toThrow('REPLY_ASSIST_MODEL_NOT_CONFIGURED');
    expect(f.seen).toEqual([]);expect(f.stream).not.toHaveBeenCalled();
    expect(()=>f.services.sessions.update('a',{runtimeConfig:{replyAssistGoal:'Explore'}})).not.toThrow();
  });
  it('uses the saved session preset and resumes following the app default when cleared',async()=>{
    const {presets,sessions}=f.services;
    const override=presets.create({...presets.getDefault('reply_assist'),name:'Session preset'});
    presets.update(override.id,{apiModelConfigId:'model'});
    const path='/api/v1/sessions/a';
    const patch=(id:string|null)=>f.app.request(path,{method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({runtimeConfig:{replyAssistPresetId:id}})});
    expect((await (await patch('sr-default-preset')).json()).errorCode).toBe('PRESET_TYPE_MISMATCH');
    expect((await (await patch(override.id)).json()).data.item.runtimeConfig.replyAssistPresetId).toBe(override.id);
    sessions.update('a',{runtimeConfig:{replyAssistGoal:'Explore'}});
    expect((await (await f.app.request(path)).json()).data.item.runtimeConfig.replyAssistPresetId).toBe(override.id);
    expect(()=>f.usecases.deletePreset(override.id)).toThrow('REFERENCE_CONFLICT');
    f.submit('a');
    expect(()=>sessions.update('a',{runtimeConfig:{replyAssistPresetId:null}})).toThrow('SESSION_WRITE_LOCKED');
    expect(()=>f.submit('b')).toThrow('REPLY_ASSIST_MODEL_NOT_CONFIGURED');
    await vi.waitFor(()=>expect(f.seen.at(-1)?.event).toBe('reply_assist.completed'));
    expect((await (await patch(null)).json()).data.item.runtimeConfig.replyAssistPresetId).toBeNull();
    expect(()=>f.usecases.deletePreset(override.id)).not.toThrow();
    expect(()=>f.submit('a')).toThrow('REPLY_ASSIST_MODEL_NOT_CONFIGURED');
    f.bind();
    f.submit('a');
    await vi.waitFor(()=>expect(f.stream).toHaveBeenCalledTimes(2));
  });
  it('keeps the latest user in history, expands each goal once and emits only text without writing entries',async()=>{
    f.bind();
    const {sessions}=f.services;
    const entry=sessions.appendEntry('a',{type:'message',role:'user',runId:'n',payload:{message:{role:'user',content:'saved input',timestamp:1}}});
    sessions.update('a',{runtimeConfig:{replyAssistGoal:'find {{user}}'}});sessions.update('b',{runtimeConfig:{replyAssistGoal:'different goal'}});
    f.submit('a','draft {{user}}');
    expect(()=>f.submit()).toThrow('REPLY_ASSIST_ALREADY_ACTIVE');
    expect(()=>f.usecases.narrative.submit({sessionId:'a',input:{text:'no'},expectedTipEntryId:entry.id})).toThrow('REPLY_ASSIST_ALREADY_ACTIVE');
    expect(()=>f.usecases.narrative.regenerate({sessionId:'a',userEntryId:entry.id,assistantEntryId:null,expectedTipEntryId:entry.id})).toThrow('REPLY_ASSIST_ALREADY_ACTIVE');
    expect(()=>sessions.delete('a')).toThrow('SESSION_WRITE_LOCKED');
    expect(()=>sessions.setState('a',{})).toThrow('STATE_WRITE_LOCKED');
    expect(()=>f.services.worlds.setState('world',{})).not.toThrow();
    f.submit('b');
    await vi.waitFor(()=>expect(f.seen.at(-1)?.event).toBe('reply_assist.completed'));
    const messages=f.stream.mock.calls[0]![1];
    expect(messages.map(m=>m.content)).toContain('find {{user}}');
    expect(messages.at(-2)).toMatchObject({role:'user',content:'saved input'});
    expect(messages.at(-1)?.content).toContain('draft {{user}}');
    expect(f.stream.mock.calls[1]![1].map(m=>m.content)).toContain('different goal');
    expect(f.seen.map(e=>e.event)).toEqual(['reply_assist.delta','reply_assist.completed']);
    expect(f.seen[1]!.data.snapshot).toEqual({content:'new draft'});
    expect(JSON.stringify(f.seen)).not.toContain('private');
    expect(sessions.getHistory('a')).toEqual([entry]);
  });
  it('uses request identity for stop, releases before terminal, and cancels a blocked credential read at shutdown',async()=>{
    f.bind();
    vi.spyOn(f.services.credentials,'get').mockImplementation(()=>new Promise(()=>{}));
    const first=f.submit();
    expect(()=>f.usecases.replyAssist.stop('a',randomUUID())).toThrow('REPLY_ASSIST_NOT_FOUND');
    let nextId='';
    f.events.subscribe('a',event=>{if(event.data.requestId===first.requestId) nextId=f.submit().requestId;});
    f.usecases.replyAssist.stop('a',first.requestId);
    await vi.waitFor(()=>expect(nextId).not.toBe(''));
    expect(()=>f.submit()).toThrow('REPLY_ASSIST_ALREADY_ACTIVE');
    expect(()=>f.usecases.replyAssist.stop('a',first.requestId)).toThrow('REPLY_ASSIST_NOT_FOUND');
    await f.app.shutdown();
    expect(f.seen.map(e=>e.data.stop_reason)).toEqual(['cancelled','server_shutdown']);
    expect(()=>f.services.sessions.update('a',{runtimeConfig:{replyAssistGoal:'unlocked'}})).not.toThrow();
  });
  it.each([
    ['length','output_limit_reached'], ['tool_calls','tool_execution_unsupported'],
    ['deferred','output_incomplete'], ['stop','model_output_invalid'],
  ] as const)('reports an unusable %s response without leaking reasoning',async(finishReason,expected)=>{
    f.bind();
    f.stream.mockImplementation(async function*(){
      yield {type:'done',finishReason,usage:null,snapshot:{role:'assistant',content:'',reasoning_content:'hidden',tool_calls:[]}};
    });
    f.submit();
    await vi.waitFor(()=>expect(f.seen).toHaveLength(1));
    expect(f.seen[0]).toMatchObject({event:'reply_assist.stopped',data:{stop_reason:expected,snapshot:{content:''}}});
    expect(JSON.stringify(f.seen)).not.toContain('hidden');
  });
  it('preserves usable deltas when the provider returns an empty error snapshot',async()=>{
    f.bind();
    f.stream.mockImplementation(async function*(){
      yield {type:'delta',delta:{content:'partial draft'}};
      yield {type:'error',stopReason:'provider_error',usage:null,snapshot:{role:'assistant',content:'',reasoning_content:'',tool_calls:[]}};
    });
    f.submit();
    await vi.waitFor(()=>expect(f.seen.at(-1)?.event).toBe('reply_assist.stopped'));
    expect(f.seen.at(-1)?.data).toMatchObject({stop_reason:'provider_error',snapshot:{content:'partial draft'}});
  });
  it('validates type and local binding while keeping portable files independent of installed models',()=>{
    const bound=f.bind()!;
    const doc=f.services.presets.toDocument(bound);
    expect(doc.type).toBe('reply_assist');expect(doc).not.toHaveProperty('apiModelConfigId');
    expect(doc.context_strategy).not.toHaveProperty('summary_prompt');
    expect(f.services.presets.importDocument(doc)).toMatchObject({type:'reply_assist',apiModelConfigId:null});
    expect(()=>f.services.sessions.update('a',{runtimeConfig:{narrativePresetId:bound.id}})).toThrow('PRESET_TYPE_MISMATCH');
    expect(()=>f.services.settings.update({defaultReplyAssistPresetId:'sr-default-preset'})).toThrow('PRESET_TYPE_MISMATCH');
    expect(()=>f.services.presets.update(bound.id,{type:'narrative'})).toThrow('PRESET_TYPE_MISMATCH');
    expect(()=>f.usecases.deletePreset(bound.id)).toThrow('REFERENCE_CONFLICT');
    expect(()=>f.services.presets.update(bound.id,{apiModelConfigId:'missing'})).toThrow('MODEL_CONFIG_NOT_FOUND');
  });
  it('requires host origin and session access for both routes and matches stop to the accepted request',async()=>{
    f.bind();
    vi.spyOn(f.services.credentials,'get').mockImplementation(()=>new Promise(()=>{}));
    const id=randomUUID(), path='/api/v1/sessions/a/reply-assist', stop=path+'/'+id+'/stop';
    const init={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:id,draftText:'hello'})};
    const denied=createApp({services:f.services,usecases:f.usecases,events:f.events,canAccessSession:()=>false});
    for(const route of [path,stop]){
      expect((await denied.request(route,init)).status).toBe(404);
      expect((await f.app.request(route,{...init,headers:{...init.headers,Origin:'http://127.0.0.1:5177'}})).status).toBe(403);
    }
    const accepted=await f.app.request(path,init);
    expect(accepted.status).toBe(202);expect((await accepted.json()).data).toEqual({accepted:true,sessionId:'a',requestId:id});
    expect((await f.app.request(path+'/'+randomUUID()+'/stop',{method:'POST'})).status).toBe(404);
    expect((await f.app.request(stop,{method:'POST'})).status).toBe(200);
    await vi.waitFor(()=>expect(f.seen.at(-1)?.data.stop_reason).toBe('cancelled'));
  });
  it('includes draft length in budget, preserves the last run and can disable history',async()=>{
    const preset=f.bind()!;
    const {sessions,presets}=f.services;
    for(const [id,text] of [['older','x'.repeat(6000)],['latest','latest visible']])sessions.appendEntry('a',{
      type:'message',role:'assistant',runId:id!,payload:{message:{role:'assistant',content:text!,timestamp:1}},
    });
    preset.config.contextStrategy.maxContextTokens=600;
    presets.update(preset.id,{config:preset.config});
    expect(()=>f.submit('a','x'.repeat(6000))).toThrow('CONTEXT_BUDGET_EXCEEDED');
    f.submit();await vi.waitFor(()=>expect(f.seen.at(-1)?.event).toBe('reply_assist.completed'));
    expect(f.stream.mock.calls[0]![1].some(m=>m.content==='latest visible')).toBe(true);
    expect(f.stream.mock.calls[0]![1].some(m=>m.content.includes('x'.repeat(6000)))).toBe(false);
    preset.config.nodes.find(n=>n.id==='chatHistory')!.enabled=false;
    presets.update(preset.id,{config:preset.config});f.submit();
    await vi.waitFor(()=>expect(f.stream).toHaveBeenCalledTimes(2));
    expect(f.stream.mock.calls[1]![1].some(m=>m.content==='latest visible')).toBe(false);
  });
});
