import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Api,AssistantMessage,AssistantMessageEvent,Model} from '@earendil-works/pi-ai';
import {openDatabase} from '../../infrastructure/database/database.js';
import {parseCard} from '../../domain/world-card.js';
import {initialState} from '../../domain/state/state.js';
import type {StateDefinition} from '@sillyrealms/sdk/state-validation';
import {WorldRepository} from '../../repositories/world-repository.js';
import {defaultPreset} from '../../domain/preset/schema.js';
import {updatePreset} from '../../repositories/preset-repository.js';
import {SRRuntime} from '../sr-runtime.js';
import {DirectRunner} from '../runners/direct-runner.js';
import {RunStore} from '../persistence/run-store.js';
import {processResponse} from './processor.js';
import {handleActionSuggestions} from './action-suggestions.js';
import {initialExtensions,rejectExtensions,persistableExtensions} from './contracts.js';
import {stateManifest} from '../../../../studio/src/features/sessions/state-manifest.js';
import {ActionSuggestionStore} from '../../../../studio/src/features/sessions/action-suggestions.js';
import type {ActionSuggestionsEvent} from '../../../../../packages/sr-sdk/src/run-contract.js';

const items=['观察四周','询问来意','前往大厅'];
const suggestions='<action_suggestions>'+JSON.stringify(items)+'</action_suggestions>';
const state=(value:unknown)=>'<state_update>'+JSON.stringify(value)+'</state_update>';
const plan={presetHash:'hash',state_update:{enabled:true,required:true,roots:['score']},action_suggestions:{enabled:true}};
const fields={score:{type:'number',initial:0,min:0,description:'已经获得的分数',rules:{score:'按本轮已发生事件更新，最低为0。'}}} satisfies Record<string,StateDefinition>;
const profileFields={profile:{type:'json',initial:{coins:0},description:'人物状态',rules:{profile:'只记录已经发生的变化。','profile.coins':'完整金币新值。'}}} satisfies Record<string,StateDefinition>;
const cases=[
  {name:'applied state',tail:state([{path:'score',value:2}]),status:'applied',score:2},
  {name:'unchanged state',tail:state([]),status:'unchanged',score:0},
  {name:'two invalid items',tail:state([{path:'score',value:2},{path:'score',value:-1},{path:'missing',value:1}]),status:'partial',score:2},
  {name:'all items invalid',tail:state([{path:'score',value:-1},{path:'missing',value:1}]),status:'partial',score:0},
  {name:'invalid block shape',tail:state({score:2}),status:'failed',score:0},
  {name:'invalid framed JSON',tail:'<state_update>[true false]</state_update>',status:'failed',score:0},
  {name:'unbalanced JSON brackets',tail:'<state_update>[{"path":"score","value":2}</state_update>',status:'failed',score:0},
  {name:'mismatched JSON brackets',tail:'<state_update>[}</state_update>',status:'failed',score:0},
  {name:'excessive JSON depth',tail:'<state_update>'+'['.repeat(34)+'0'+']'.repeat(34)+'</state_update>',status:'failed',score:0},
  {name:'duplicate JSON keys',tail:'<state_update>[{"path":"score","path":"other","value":2}]</state_update>',status:'failed',score:0},
  {name:'missing state block',tail:'',status:'failed',score:0},
];

afterEach(()=>vi.restoreAllMocks());

describe('independent plugin validation',()=>{
  it.each(cases)('keeps valid suggestions when state has $name',({tail,status,score})=>{
    const result=processResponse(tail+suggestions,plan,{score:0},fields);
    expect(result.workspace).toEqual({score});
    expect(result.extensions.stateUpdate.status).toBe(status);
    expect(result.extensions.actionSuggestions).toEqual({status:'ready',items});
  });
  it('keeps valid state updates when suggestions fail',()=>{
    const result=processResponse(state([{path:'score',value:2}])+'<action_suggestions>["same","same","other"]</action_suggestions>',plan,{score:0},fields);
    expect(result.workspace).toEqual({score:2});
    expect(result.extensions.stateUpdate.status).toBe('applied');
    expect(result.extensions.actionSuggestions).toEqual({status:'failed',items:[]});
  });
  it('does not revive cancelled or blocked suggestions',()=>{
    for(const cancelled of [true,false]){
      const initial=rejectExtensions(initialExtensions(plan),cancelled);
      expect(handleActionSuggestions({value:items},initial.actionSuggestions)).toEqual(initial.actionSuggestions);
    }
  });
});

const model:Model<Api>={id:'fake',name:'fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32768,maxTokens:4096};
function fixture(tail:string,reason:AssistantMessage['stopReason']='stop',definitions:Record<string,StateDefinition>=fields,stateEnabled=true){
  const stateDefinition={schema_version:2 as const,scopes:{message:definitions}};
  const initial=initialState(stateDefinition,'message');
  const db=openDatabase(':memory:');
  db.prepare('INSERT INTO api_model_configs VALUES(?,?,?,?,?,?,?)').run('model','test','fake','fake','ref',1,1);
  new WorldRepository(db).insert({id:'world',card:parseCard({spec:'world_card',spec_version:'0.1',data:{name:'Test',characters:[{id:'p',name:'Player',player_selectable:true}],openings:[{id:'o',name:'Opening',content:'Opening'}],state:stateDefinition}}),sourcePath:null,sourceHash:null,sourceKind:'generated',presetId:'sr-default-preset',modelId:'model',now:1});
  const preset=defaultPreset();preset.context_strategy.max_context_tokens=16000;preset.context_strategy.max_output_tokens=128;
  preset.config_json.nodes.find(node=>node.id==='worldState')!.enabled=stateEnabled;
  updatePreset(db,'sr-default-preset',preset);
  db.prepare('INSERT INTO sessions(id,world_id,preset_id,api_model_config_id,user_character_id,tip_entry_id,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('session','world','sr-default-preset','model','p','opening',null,'{}',1,1);
  db.prepare('INSERT INTO entries(id,session_id,parent_id,run_id,seq,type,role,branch_count,timestamp,payload,state,ext_data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('opening','session',null,'opening-run',1,'message','assistant',0,1,JSON.stringify({message:{role:'assistant',content:'Opening'}}),JSON.stringify(Object.entries(initial).map(([key,value])=>({key,value}))),'{"run":{"status":"completed"}}');
  const message:AssistantMessage={role:'assistant',content:[{type:'text',text:'故事继续。'+tail}],api:'openai-completions',provider:'fake',model:'fake',usage:{input:20,output:10,cacheRead:0,cacheWrite:0,totalTokens:30,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:reason,timestamp:1};
  const runtime=new SRRuntime(db,{get:async()=>'fake',set:async()=>{},deleteSync:()=>{}},{resolve:()=>model,supportsDirect:()=>true,stream:()=>({async *[Symbol.asyncIterator](){yield {type:'done',reason,message} as AssistantMessageEvent;}})});
  const events:Array<{event:string;data:Record<string,any>}>=[];
  const displayed:ActionSuggestionsEvent[]=[];
  const host=new ActionSuggestionStore('session',event=>displayed.push(event));
  runtime.onEvent((_session,event,data)=>{
    events.push({event,data});
    if(event==='run.updated'){
      host.accepted(String(data.runId));
      const run=runtime.status('session',String(data.runId));
      host.settled(String(data.runId),String(data.status),run?.messages??[]);
    }
    if(event==='action_suggestions.changed')host.receive(data as ActionSuggestionsEvent['data']);
  });
  return {db,runtime,events,displayed,async run(){
    const {runId,stream}=await runtime.prepare('session','继续',crypto.randomUUID(),'opening');
    const reader=stream.getReader();let text='';
    try {while(true){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);}}
    finally {reader.releaseLock();}
    return {runId,text,status:runtime.status('session',runId)};
  },async close(){await runtime.shutdown();db.close();}};
}

describe('committed suggestion publication and Host delivery',()=>{
  it.each(cases)('publishes and displays suggestions with $name',async({tail,status,score})=>{
    const f=fixture(tail+suggestions);
    try {
      const run=await f.run();
      expect(run.text).toBe('故事继续。');
      expect(run.status).toMatchObject({status:'completed',extensions:{stateUpdate:{status},actionSuggestions:{status:'ready'}}});
      const messages=run.status!.messages as Array<{id:string;role:string}>;
      const messageId=messages.find(message=>message.role==='assistant')!.id;
      expect(f.events.filter(event=>event.event==='action_suggestions.changed')).toEqual([{event:'action_suggestions.changed',data:{sessionId:'session',suggestions:{runId:run.runId,messageId,items}}}]);
      expect(f.displayed.at(-1)?.data.suggestions).toEqual({runId:run.runId,messageId,items});
      const saved=f.db.prepare('SELECT state FROM entries WHERE id=?').get(messageId);
      expect(saved?.state===null?0:JSON.parse(String(saved?.state))[0].value).toBe(score);
      expect(f.events.filter(event=>event.event==='state.changed')).toHaveLength(score===2?1:0);
    } finally {await f.close();}
  });
  it('keeps suggestions when final state snapshot validation fails',async()=>{
    const execute=DirectRunner.prototype.execute;
    vi.spyOn(DirectRunner.prototype,'execute').mockImplementation(async function(this:DirectRunner,args){
      const result=await execute.call(this,args);
      result.workspace={score:-1};
      return result;
    });
    const f=fixture(state([{path:'score',value:2}])+suggestions);
    try {
      const run=await f.run();
      expect(run.status).toMatchObject({status:'completed',extensions:{stateUpdate:{status:'failed'},actionSuggestions:{status:'ready'}}});
      expect(f.displayed.at(-1)?.data.suggestions?.items).toEqual(items);
      expect(f.events.some(event=>event.event==='state.changed')).toBe(false);
    } finally {await f.close();}
  });
  it.each(['cancelled','uncommitted','commit failure','incomplete narrative'] as const)('does not publish on %s',async scenario=>{
    if(scenario==='cancelled'){
      const execute=DirectRunner.prototype.execute;
      vi.spyOn(DirectRunner.prototype,'execute').mockImplementation(async function(this:DirectRunner,args){
        const result=await execute.call(this,args);args.task.stopped=true;return result;
      });
    }
    if(scenario==='uncommitted')vi.spyOn(RunStore.prototype,'finalize').mockReturnValue(false);
    if(scenario==='commit failure')vi.spyOn(RunStore.prototype,'finalize').mockImplementation(()=>{throw Error('write failed');});
    const f=fixture(state({invalid:true})+suggestions,scenario==='incomplete narrative'?'length':'stop');
    try {
      const run=await f.run();
      expect(f.events.some(event=>event.event==='action_suggestions.changed')).toBe(false);
      expect(f.displayed.every(event=>event.data.suggestions===null)).toBe(true);
      const saved=f.db.prepare("SELECT state FROM entries WHERE run_id=? AND role='assistant'").all(run.runId);
      expect(saved.every(row=>row.state===null)).toBe(true);
      if(scenario==='cancelled')expect(run.status).toMatchObject({status:'stopped',extensions:{actionSuggestions:{status:'cancelled'}}});
      if(scenario==='commit failure')expect(run.status).toMatchObject({status:'failed',errorCode:'STATE_COMMIT_FAILED'});
    } finally {await f.close();}
  });
});

describe('state v2 lifecycle boundaries',()=>{
  it('keeps field diagnostics ephemeral while preserving independent suggestions',()=>{
    const localPlan={...plan,state_update:{enabled:true,required:true,roots:['profile']}};
    const result=processResponse(state([
      {path:'profile.coins',value:2,reason:'本轮得到金币'},
      {path:'profile',value:{coins:9,undeclared:true}},
      {path:'profile.coins',value:3},
    ])+suggestions,localPlan,{profile:{coins:0}},profileFields);
    expect(result.workspace).toEqual({profile:{coins:3}});
    expect(result.extensions.stateUpdate).toMatchObject({status:'partial',diagnostics:[{
      index:1,scope:'message',path:'profile',errorCode:'STATE_RULE_MISSING',rulePath:'profile.undeclared',
    }]});
    expect(result.extensions.actionSuggestions).toEqual({status:'ready',items});
    expect(persistableExtensions(result.extensions)).toEqual({stateUpdate:{status:'partial'},actionSuggestions:{status:'ready'}});
  });

  it('commits valid changes and publishes suggestions after a rule coverage failure',async()=>{
    const f=fixture(state([
      {path:'profile.coins',value:2,reason:'not-persisted-reason'},
      {path:'profile',value:{coins:99,undeclared:true}},
    ])+suggestions,'stop',profileFields);
    try{
      const run=await f.run();
      expect(run.status).toMatchObject({status:'completed',extensions:{stateUpdate:{status:'partial'},actionSuggestions:{status:'ready'}}});
      const changed=f.events.filter(event=>event.event==='state.changed');
      expect(changed).toEqual([{event:'state.changed',data:{path:'profile',scope:'message',value:{coins:2}}}]);
      expect(f.displayed.at(-1)?.data.suggestions?.items).toEqual(items);
      const assistant=f.db.prepare("SELECT state,payload FROM entries WHERE run_id=? AND role='assistant'").get(run.runId)!;
      expect(JSON.parse(String(assistant.state))).toEqual([{key:'profile',value:{coins:2}}]);
      expect(JSON.stringify(assistant)).not.toContain('state_update');
      expect(JSON.stringify(assistant)).not.toContain('not-persisted-reason');
      const user=f.db.prepare("SELECT ext_data FROM entries WHERE run_id=? AND role='user'").get(run.runId)!;
      expect(JSON.parse(String(user.ext_data)).run.extensions.stateUpdate).toEqual({status:'partial'});
      const ordered=f.events.filter(event=>event.event==='message.final'||event.event==='state.changed'||(event.event==='run.updated'&&event.data.status==='completed')||event.event==='action_suggestions.changed'&&event.data.suggestions!==null).map(event=>event.event);
      expect(ordered).toEqual(['message.final','state.changed','run.updated','action_suggestions.changed']);
    }finally{await f.close();}
  });

  it('keeps Run completed and suggestions ready when final snapshot lacks a rule',async()=>{
    const execute=DirectRunner.prototype.execute;
    vi.spyOn(DirectRunner.prototype,'execute').mockImplementation(async function(this:DirectRunner,args){
      const result=await execute.call(this,args);
      result.workspace={profile:{coins:2,undeclared:true}};
      return result;
    });
    const f=fixture(state([{path:'profile.coins',value:2}])+suggestions,'stop',profileFields);
    try{
      const run=await f.run();
      expect(run.status).toMatchObject({status:'completed',extensions:{stateUpdate:{status:'failed'},actionSuggestions:{status:'ready'}}});
      expect(f.displayed.at(-1)?.data.suggestions?.items).toEqual(items);
      expect(f.events.some(event=>event.event==='state.changed')).toBe(false);
      const saved=f.db.prepare("SELECT state FROM entries WHERE run_id=? AND role='assistant'").get(run.runId)!;
      expect(saved.state).toBeNull();
    }finally{await f.close();}
  });

  it.each(['disabled','not_required'] as const)('does not gate suggestions on state %s',async status=>{
    const f=fixture(suggestions,'stop',status==='not_required'?{}:fields,status!=='disabled');
    try{
      const run=await f.run();
      expect(run.status).toMatchObject({status:'completed',extensions:{stateUpdate:{status},actionSuggestions:{status:'ready'}}});
      expect(f.displayed.at(-1)?.data.suggestions?.items).toEqual(items);
      const saved=f.db.prepare("SELECT state FROM entries WHERE run_id=? AND role='assistant'").get(run.runId)!;
      expect(saved.state).toBeNull();
    }finally{await f.close();}
  });

  it('rejects a baseline conflict without committing or publishing candidate state',async()=>{
    const finalize=RunStore.prototype.finalize;
    vi.spyOn(RunStore.prototype,'finalize').mockImplementation(function(this:RunStore,sessionId,userId,outcome,workspace,failure,options){
      return finalize.call(this,sessionId,userId,outcome,workspace,failure,{...options,baselineHash:'conflicting-baseline'});
    });
    const f=fixture(state([{path:'score',value:2}])+suggestions);
    try{
      const run=await f.run();
      expect(run.status).toMatchObject({status:'failed',errorCode:'TIP_CONFLICT'});
      expect(f.events.some(event=>event.event==='state.changed'||event.event==='action_suggestions.changed'&&event.data.suggestions!==null)).toBe(false);
      const saved=f.db.prepare("SELECT state FROM entries WHERE run_id=? AND role='assistant'").get(run.runId)!;
      expect(saved.state).toBeNull();
    }finally{await f.close();}
  });

  it('passes only root names into the stage state manifest',()=>{
    const definition={schema_version:2,scopes:{message:profileFields,global:fields}};
    const manifest=stateManifest(definition);
    expect(manifest).toEqual({scopes:{global:{score:true},message:{profile:true}}});
    expect(JSON.stringify(manifest)).not.toMatch(/rules|initial|description|完整金币/);
    expect(definition.scopes.message.profile.rules['profile.coins']).toBe('完整金币新值。');
  });
});
