import React from 'react';
import {createRoot} from 'react-dom/client';
import {SessionHost} from '../../src/host';
import '../../src/style.css';
import '../../src/design-system/tokens.css';
import '../../src/design-system/studio.css';
import '../../src/features/sessions/composer/roleplay-composer.css';

class FakeEventSource {
  onopen:(()=>void)|null=null;onerror:(()=>void)|null=null;
  constructor(){setTimeout(()=>this.onopen?.(),10);}
  addEventListener(){}
  close(){}
}
(globalThis as any).EventSource=FakeEventSource;
const realFetch=window.fetch.bind(window);
const messages=Array.from({length:200},(_,index)=>({
  id:'message-'+index,role:index%2===0?'user' as const:'assistant' as const,
  text:'这是用于验证长会话阅读字号稳定性的消息。随着历史消息增加，字号应该保持一致，不应自动缩小。第 '+(index+1)+' 条。',
}));
window.fetch=async(input,init)=>{
  const path=String(input);if(!path.startsWith('/api/'))return realFetch(input,init);
  let data:unknown={};
  if(path.startsWith('/api/v1/presets?'))data={items:[{id:'preset',name:'测试预设'}],hasMore:false};
  else if(path==='/api/v1/api-model-configs')data={items:[{id:'model',name:'测试模型',modelId:'fake'}]};
  else if(path==='/api/v1/sessions/test'&&init?.method==='PATCH')data={};
  else if(path==='/api/v1/sessions/test')data={tipEntryId:'tip',worldId:'world',title:'字体回归',presetId:'preset',apiModelConfigId:'model'};
  else if(path==='/api/v1/worlds/world')data={item:{data:{characters:[],state:{scopes:{}}}}};
  else if(path==='/api/v1/sessions/test/state')data={global:{},session:{},message:{}};
  else if(path.startsWith('/api/v1/sessions/test/runs?'))data={runs:[{id:'font-run',status:'completed',messages}],nextCursor:null,hasMore:false};
  else if(path==='/api/v1/sessions/test/usage')data={cumulative:{inputTokens:10000,outputTokens:1200,totalTokens:11200,cacheReadTokens:2000,cacheWriteTokens:500,cacheHitRate:.2,complete:true,unknownCount:0},latestContext:{inputTokens:6000,contextWindowTokens:128000,ratio:6000/128000,modelId:'fake',stale:false,contextComposition:{systemBytes:1000,summaryBytes:2000,historyBytes:3000}}};
  return new Response(JSON.stringify({code:'OK',data}),{status:200,headers:{'content-type':'application/json'}});
};
createRoot(document.getElementById('root')!).render(<div className="sr-shell"><SessionHost id="test"/></div>);
