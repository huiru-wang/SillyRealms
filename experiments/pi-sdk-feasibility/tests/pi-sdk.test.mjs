import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createAgentSession, SessionManager, ModelRuntime, SettingsManager, DefaultResourceLoader,
} from '@earendil-works/pi-coding-agent';

const text = message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
const user = content => ({ role:'user', content, timestamp:Date.now() });
const system = content => ({ role:'system',content,timestamp:Date.now() });
const makeTemp = () => mkdtempSync(join(tmpdir(),'sr-pi-test-'));
const cleanup = p => rmSync(p,{recursive:true,force:true});

async function mockServer({ slow = false }={}) {
  const requests=[];
  const srv=createServer(async(req,res)=>{
    if(req.method!=='POST') { res.writeHead(200,{'content-type':'application/json'}); res.end('{"data":[]}');return; }
    let body='';for await(const chunk of req)body+=chunk;
    const request=JSON.parse(body);requests.push({method:req.method,path:req.url,...request});
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});
    const write=(content,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'mock-model',choices:[{index:0,delta:content?{content}:{},finish_reason}]})}\n\n`);
    res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'mock-model',choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]})}\n\n`);
    write('PART_ONE');
    if (!slow) {write('_PART_TWO');write('', 'stop');res.end('data: [DONE]\n\n');return;}
    const timer=setTimeout(()=>{if(!res.destroyed){write('_DELAYED');write('', 'stop');res.end('data: [DONE]\n\n');}},1500);
    res.on('close',()=>clearTimeout(timer));
  });
  await new Promise(resolve=>srv.listen(0,'127.0.0.1',resolve));
  return {requests,url:`http://127.0.0.1:${srv.address().port}/v1`,close:()=>new Promise(resolve=>srv.close(resolve))};
}

async function sdkSession(tmp,url,sessionManager=SessionManager.inMemory(tmp)) {
  const settingsManager=SettingsManager.inMemory({compaction:{enabled:false}});
  const resourceLoader=new DefaultResourceLoader({cwd:tmp,agentDir:join(tmp,'agent'),settingsManager,
    noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'FIXTURE_SYSTEM'});
  await resourceLoader.reload();
  const modelRuntime=await ModelRuntime.create({authPath:join(tmp,'auth.json'),modelsPath:null,refreshOnCreate:false});
  modelRuntime.registerProvider('pi-mock',{baseUrl:url,api:'openai-completions',apiKey:'only-a-mock-key',models:[{
    id:'mock-model',name:'Local mock, not real AI',input:['text'],reasoning:false,contextWindow:8192,maxTokens:1024,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
  }]});
  const model=modelRuntime.getModel('pi-mock','mock-model');
  assert.ok(model);
  const {session}=await createAgentSession({cwd:tmp,agentDir:join(tmp,'agent'),model,modelRuntime,sessionManager,
    resourceLoader,settingsManager,noTools:'all'});
  return {session,loader:resourceLoader,sm:sessionManager};
}

function setRequestOverride(session, makeMessages) {
  const upstream=session.agent.prepareRequest;
  session.agent.prepareRequest=async (request,signal)=>{
    const base=await upstream?.(request,signal)??{};
    const original=base.context??request.context;
    return {...base,context:{...original,messages:makeMessages(original.messages)}};
  };
}

test('SessionManager: in-memory, branch-scoped reading, import from entries', async()=>{
  const tmp=makeTemp();try{
    const sm=SessionManager.inMemory(tmp);const root=sm.appendMessage(user('COMMON_ROOT'));
    const leafA=sm.appendMessage(user('BRANCH_A'));
    sm.branch(root);const leafB=sm.appendMessage(user('BRANCH_B'));
    assert.notEqual(leafA,leafB);
    assert.deepEqual(sm.buildSessionContext().messages.map(text),['COMMON_ROOT','BRANCH_B']);
    sm.branch(leafA);
    assert.deepEqual(sm.buildSessionContext().messages.map(text),['COMMON_ROOT','BRANCH_A']);
    const files=[sm.getHeader(),...sm.getEntries()].filter(Boolean);
    const reconstructed=SessionManager.inMemory(tmp,undefined,files);
    // Loading raw entries alone chooses the last appended leaf (B), not our separately selected leaf (A).
    assert.deepEqual(reconstructed.buildSessionContext().messages.map(text),['COMMON_ROOT','BRANCH_B']);
    reconstructed.branch(leafA); // Explicitly restore SillyRealms sessions.active_leaf_entry_id.
    assert.deepEqual(reconstructed.buildSessionContext().messages.map(text),['COMMON_ROOT','BRANCH_A']);
    assert.equal(reconstructed.isPersisted(),false);
  }finally{cleanup(tmp);}
});

test('SessionManager: native JSONL persistence can reopen, no SQLite adapter implied',async()=>{
  const tmp=makeTemp();try{
    const sm=SessionManager.create(tmp,join(tmp,'pi-jsonl'));
    sm.appendMessage(user('SESSION_CONTENT'));
    assert.ok(sm.getSessionFile());
    const reopened=SessionManager.open(sm.getSessionFile());
    assert.deepEqual(reopened.buildSessionContext().messages.map(text),['SESSION_CONTENT']);
  }finally{cleanup(tmp);}
});

test('SDK: no tools/resources, custom system prompt; Pi adds cwd context',async()=>{
  const tmp=makeTemp();const fake=await mockServer();let session;
  try{
    const loaded=await sdkSession(tmp,fake.url);session=loaded.session;
    assert.deepEqual(session.getActiveToolNames(),[]);
    assert.equal(session.sessionFile,undefined);
    assert.deepEqual([loaded.loader.getSkills().skills.length,loaded.loader.getPrompts().prompts.length,loaded.loader.getAgentsFiles().agentsFiles.length],[0,0,0]);
    assert.equal(loaded.loader.getExtensions().extensions.length,0);
    assert.match(session.systemPrompt,/FIXTURE_SYSTEM/);
    assert.match(session.systemPrompt,/<cwd>/);
  }finally{session?.dispose();await fake.close();cleanup(tmp);}
});

test('Mock stream: sends seeded history+current input; final reply and settle events work',async()=>{
  const tmp=makeTemp();const fake=await mockServer();let session;
  try{
    const sm=SessionManager.inMemory(tmp);sm.appendMessage(user('OPENING_FIXTURE'));
    ({session}=await sdkSession(tmp,fake.url,sm));
    const deltas=[];const types=[];session.subscribe(event=>{types.push(event.type);if(event.type==='message_update'&&event.assistantMessageEvent?.type==='text_delta')deltas.push(event.assistantMessageEvent.delta);});
    await session.prompt('SENT_INPUT');
    assert.equal(session.getLastAssistantText(),'PART_ONE_PART_TWO');
    assert.equal(deltas.join(''),'PART_ONE_PART_TWO');
    assert.equal(fake.requests.length,1);
    assert.deepEqual(fake.requests[0].messages.slice(1).map(x=>x.role),['user','user']);
    assert.equal(fake.requests[0].messages[1].content,'OPENING_FIXTURE');
    assert.ok(JSON.stringify(fake.requests[0].messages[2].content).includes('SENT_INPUT'));
    assert.ok(types.includes('agent_settled'));
  }finally{session?.dispose();await fake.close();cleanup(tmp);}
});

test('PrepareRequest adapter: precise post-history USER instruction position can be preserved',async()=>{
  const tmp=makeTemp();const fake=await mockServer();let session;
  try{
    ({session}=await sdkSession(tmp,fake.url));
    setRequestOverride(session,()=>[system('PRESET_MAIN'),user('OPENING'),user('LAST_USER'),user('POST_HISTORY_USER')]);
    await session.prompt('IGNORED_NATIVE_INPUT');
    const sent=fake.requests[0].messages;
    assert.deepEqual(sent.map(x=>x.role),['system','user','user','user']);
    assert.equal(sent.at(-1).content,'POST_HISTORY_USER');
    assert.equal(sent[0].content,'PRESET_MAIN');
  }finally{session?.dispose();await fake.close();cleanup(tmp);}
});

test('OpenAI-compatible adapter repositions system after history into head (limitation)',async()=>{
  const tmp=makeTemp();const fake=await mockServer();let session;
  try{
    ({session}=await sdkSession(tmp,fake.url));
    setRequestOverride(session,()=>[system('PRESET_MAIN'),user('OPENING'),user('LAST_USER'),system('POST_HISTORY_SYSTEM')]);
    await session.prompt('IGNORED_NATIVE_INPUT');
    const sent=fake.requests[0].messages;
    assert.equal(sent.at(-1).role,'user');
    assert.ok(sent[0].content.includes('POST_HISTORY_SYSTEM'));
    assert.ok(sent[0].content.includes('PRESET_MAIN'));
    assert.ok(!sent.slice(1).some(x=>x.role==='system'));
  }finally{session?.dispose();await fake.close();cleanup(tmp);}
});

test('Abort during SSE: runs settle without extra external requests',async()=>{
  const tmp=makeTemp();const fake=await mockServer({slow:true});let session;
  try{
    ({session}=await sdkSession(tmp,fake.url));
    let abortPromise;
    session.subscribe(ev=>{if(ev.type==='message_update'&&ev.assistantMessageEvent?.type==='text_delta'&&!abortPromise){abortPromise=session.abort();}});
    await session.prompt('ABORT_TEST');
    if(abortPromise)await abortPromise;
    assert.equal(fake.requests.length,1);
    assert.ok(session.messages.some(x=>x.role==='assistant'));
    assert.equal(session.messages.filter(x=>x.role==='assistant').at(-1).stopReason,'aborted');
    assert.equal(session.isStreaming,false);
    assert.ok(abortPromise,'streaming event did not trigger abort');
  }finally{session?.dispose();await fake.close();cleanup(tmp);}
});

test('1000-entry in-memory path: projection scales for local harness (not database/UX benchmark)',()=>{
  const tmp=makeTemp();try{
    const sm=SessionManager.inMemory(tmp);
    for(let i=0;i<1000;i++)sm.appendMessage(user(`UTTERANCE_${i}`));
    const before=performance.now();
    const built=sm.buildSessionContext();
    const elapsedMs=performance.now()-before;
    assert.equal(built.messages.length,1000);
    assert.equal(text(built.messages.at(-1)),'UTTERANCE_999');
    assert.ok(elapsedMs<5000,`Build 1000 messages unexpectedly slow: ${elapsedMs}ms`);
    console.log(`1000-message in-memory projection elapsedMs=${elapsedMs.toFixed(2)} (local fixture only)`);
  }finally{cleanup(tmp);}
});
