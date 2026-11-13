import React from 'react';
import {createRoot} from 'react-dom/client';
import {SessionHost} from '../../src/host';
import '../../src/style.css';
import '../../src/design-system/tokens.css';
import '../../src/design-system/studio.css';
import '../../src/features/sessions/composer/roleplay-composer.css';
let source:FakeEventSource,mode='direct',revision=0,overrides:Record<string,boolean>={},active:any=null;
const calls:any[]=[],history:any[]=[{id:'run-1',executionMode:'direct',status:'completed',phase:'finalized',
  messages:[{id:'u1',role:'user',text:'我走进灯火通明的大厅。'},{id:'a1',role:'assistant',text:'门在身后轻轻合上。侍者停下手中的工作，抬头看向你。\n\n“欢迎回来。您要找的人正在书房等候。”'}],
  extensions:{protocol:'sr_extensions/v1',stateUpdate:{status:'applied',acceptedCount:1,changedPaths:['score'],skipped:[],warningCodes:[]},
    actionSuggestions:{status:'ready',items:['观察大厅里的客人','向侍者询问来意','前往二楼书房'],warningCodes:[]}}}];
class FakeEventSource {
  onopen:(()=>void)|null=null;onerror:(()=>void)|null=null;listeners:Record<string,(event:MessageEvent)=>void>={};
  constructor(){source=this;setTimeout(()=>this.onopen?.(),10);}
  addEventListener(name:string,listener:(event:MessageEvent)=>void){this.listeners[name]=listener;}
  emit(event:string,data:unknown){this.listeners[event]?.({data:JSON.stringify(data)} as MessageEvent);}
  close(){}
}
(globalThis as any).EventSource=FakeEventSource;
const realFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
  const path=String(input).replace('/api/v1/sessions/second','/api/v1/sessions/test');if(!path.startsWith('/api/'))return realFetch(input,init);
  let data:any={};
  if(init?.method==='PATCH')calls.push({path,body:JSON.parse(String(init.body))});
  if(path.startsWith('/api/v1/presets?'))data={items:[{id:'preset',name:'细腻叙事'}],hasMore:false};
  else if(path==='/api/v1/api-model-configs')data={items:[{id:'model',name:'DeepSeek Flash',modelId:'deepseek-flash'}]};
  else if(path==='/api/v1/sessions/test'){
    if(init?.method==='PATCH')mode=JSON.parse(String(init.body)).executionMode??mode;
    data={tipEntryId:'a1',worldId:'world',title:'庄园来信',presetId:'preset',apiModelConfigId:'model',executionMode:mode,activeRun:active};
  }else if(path==='/api/v1/sessions/test/capabilities'){
    if(init?.method==='PATCH'){const body=JSON.parse(String(init.body));for(const [key,value] of Object.entries(body.overrides)){if(value===null)delete overrides[key];else overrides[key]=Boolean(value);}revision++;}
    data={revision,overrides,effective:{state_update:{enabled:overrides.state_update??true},action_suggestions:{enabled:overrides.action_suggestions??true,count:3}},
      sources:{state_update:Object.hasOwn(overrides,'state_update')?'session':'preset',action_suggestions:Object.hasOwn(overrides,'action_suggestions')?'session':'preset'},
      availability:{applicable:mode==='direct'},activeRun:active};
  }else if(path==='/api/v1/worlds/world')data={item:{data:{characters:[],state:{scopes:{message:{score:{type:'number',initial:1}}}}}}};
  else if(path==='/api/v1/sessions/test/state')data={global:{},session:{},message:{score:1}};
  else if(path.startsWith('/api/v1/sessions/test/runs?'))data={runs:[...history,...(active?.messages?[active]:[])],nextCursor:null,hasMore:false};
  else if(path.startsWith('/api/v1/sessions/test/runs/')){
    const runId=path.split('/').at(-1),found=active?.id===runId?active:history.find(run=>run.id===runId);
    if(!found)return new Response(JSON.stringify({success:false,errorCode:'RUN_NOT_FOUND',errorMessage:'运行不存在',data:null}),{status:404,headers:{'content-type':'application/json'}});
    data={...found,runId};
  }else if(path==='/api/v1/sessions/test/runs'&&init?.method==='POST'){calls.push({path,body:JSON.parse(String(init.body))});data={runId:'unexpected-send'};}
  else if(path==='/api/v1/sessions/test/usage')data={cumulative:{inputTokens:1200,outputTokens:200,totalTokens:1400,cacheReadTokens:0,cacheWriteTokens:0,cacheHitRate:0,complete:true,unknownCount:0},latestContext:null};
  return new Response(JSON.stringify({success:true,errorCode:null,errorMessage:'',data}),{headers:{'content-type':'application/json'}});
};
(globalThis as any).__runtimeTest={
  calls,
  begin(){active={id:'run-2',status:'preparing',phase:'preparing',executionMode:'direct',capabilities:{revision:0,stateUpdate:{enabled:true,required:true},actionSuggestions:{enabled:true,count:3}}};source.emit('run.phase',{runId:'run-2',phase:'preparing'});},
  stream(text:string,emit=true){
    active.status='running';active.phase='narrative';
    active.messages??=[{id:'u2',role:'user',text:'继续前进。'},{id:'a2',role:'assistant',text:''}];
    const message=active.messages[1],offset=message.text.length;message.text+=text;
    if(emit)source.emit('run.delta',{runId:active.id,messageId:message.id,offset,text});
  },
  duplicate(){source.emit('run.delta',{runId:active.id,messageId:'a2',offset:0,text:active.messages[1].text});},
  disconnect(){source.onerror?.();},
  finishOffline(){active=null;history.push({id:'run-2',executionMode:'direct',status:'completed',phase:'finalized',messages:[{id:'u2',role:'user',text:'继续前进。'},{id:'a2',role:'assistant',text:'书房门开了。'}]});},
  reconnect(){source.onopen?.();},
  restartPreparing(){active={id:'run-3',status:'preparing',phase:'preparing',executionMode:'direct'};source.emit('run.phase',{runId:'run-3',phase:'preparing'});},
  losePreparation(){active=null;},
  late(){source.emit('run.phase',{runId:'run-2',phase:'preparing'});},
};
const root=createRoot(document.getElementById('root')!);
root.render(<div className="sr-shell"><SessionHost id="test"/></div>);
(globalThis as any).__runtimeTest.switchSession=()=>root.render(<div className="sr-shell"><SessionHost id="second"/></div>);
