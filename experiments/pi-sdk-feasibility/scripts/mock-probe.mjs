import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {createAgentSession,SessionManager,DefaultResourceLoader,SettingsManager,ModelRuntime} from '@earendil-works/pi-coding-agent';

const tmp=mkdtempSync(join(tmpdir(),'pi-sdk-mock-'));
const requests=[];
const server=createServer(async(req,res)=>{
 if(req.method!=='POST'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[]}));return;}
 let raw='';for await(const chunk of req)raw+=chunk;
 const payload=JSON.parse(raw);requests.push({path:req.url,body:payload});
 res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});
 const send=x=>res.write('data: '+JSON.stringify(x)+'\n\n');
 send({id:'mockid',object:'chat.completion.chunk',model:'mock-model',choices:[{index:0,delta:{role:'assistant',content:''},finish_reason:null}]});
 send({id:'mockid',object:'chat.completion.chunk',model:'mock-model',choices:[{index:0,delta:{content:'MOCK_'},finish_reason:null}]});
 send({id:'mockid',object:'chat.completion.chunk',model:'mock-model',choices:[{index:0,delta:{content:'REPLY'},finish_reason:null}]});
 send({id:'mockid',object:'chat.completion.chunk',model:'mock-model',choices:[{index:0,delta:{},finish_reason:'stop'}]});
 res.end('data: [DONE]\n\n');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let session;
try{
 const baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
 const models=await ModelRuntime.create({authPath:join(tmp,'auth.json'),modelsPath:null,refreshOnCreate:false});
 models.registerProvider('pi-mock',{baseUrl,api:'openai-completions',apiKey:'not-a-real-secret',models:[{id:'mock-model',name:'Fake Model',input:['text'],reasoning:false,contextWindow:8192,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
 const model=models.getModel('pi-mock','mock-model');
 if(!model)throw Error('Mock model not registered');
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false}});
 const resourceLoader=new DefaultResourceLoader({cwd:tmp,agentDir:join(tmp,'agent'),settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noContextFiles:true,noThemes:true,systemPrompt:'ROOT_SYSTEM_CUSTOM'});
 await resourceLoader.reload();
 const sm=SessionManager.inMemory(tmp);sm.appendMessage({role:'user',content:'OPENING_CTX',timestamp:Date.now()});
 ({session}=await createAgentSession({cwd:tmp,agentDir:join(tmp,'agent'),modelRuntime:models,model,sessionManager:sm,settingsManager,resourceLoader,noTools:'all'}));
 const previousPrepare=session.agent.prepareRequest;
 session.agent.prepareRequest=async (request,signal)=>{
   const base=(await previousPrepare?.(request,signal))??{};
   const src=base.context??request.context;
   return {...base,context:{...src,messages:[
     {role:'system',content:'EXACT_PRESET_MAIN',timestamp:Date.now()},
     {role:'user',content:'OPENING_CTX',timestamp:Date.now()},
     {role:'user',content:'USER_INPUT',timestamp:Date.now()},
     {role:'system',content:'EXACT_POST_HISTORY',timestamp:Date.now()}
   ]}};
 };
 const events=[];session.subscribe(ev=>{events.push({type:ev.type,reason:ev.message?.stopReason,error:ev.message?.errorMessage,delta:ev.assistantMessageEvent?.delta});});
 await session.prompt('USER_INPUT');
 console.log(JSON.stringify({model:model.id,authConfigured:models.hasConfiguredAuth('pi-mock'),authPresent:!!(await models.getAuth('pi-mock')),text:session.getLastAssistantText(),eventTypes:events,tail:session.messages.slice(-2).map(m=>({role:m.role,stopReason:m.stopReason,errorMessage:m.errorMessage})),toolNames:session.getActiveToolNames(),requests:requests.map(x=>({path:x.path,model:x.body.model,messages:x.body.messages.map(y=>({role:y.role,content:y.content}))}))},null,2));
} catch(e){console.error(e.stack);process.exitCode=1}finally{session?.dispose();await new Promise(resolve=>server.close(resolve));rmSync(tmp,{recursive:true,force:true});}
