import type {ChatMessage,Run,RunEvent} from './run-contract.js';

/** Group consecutive assistant narrative for display without changing the underlying Run. */
export function displayMessages(messages:ChatMessage[]):ChatMessage[]{
  const result:ChatMessage[]=[];
  for(const message of messages){
    const last=result[result.length-1];
    if(message.role==='assistant' && last?.role==='assistant') last.text += '\n\n'+message.text;
    else result.push({...message});
  }
  return result;
}

/** Reduce delivered events only; missing events are not replayed. */
export function applyRunEvent(runs:Run[],event:RunEvent):Run[] {
  const {runId}=event.data;
  const previous=runs.find(run=>run.id===runId);
  const run:Run=previous?{...previous,messages:[...previous.messages]}:{id:runId,status:'running',messages:[]};
  if(event.event==='run.created'){
    for(const message of event.data.messages)if(!run.messages.some(item=>item.id===message.id))run.messages.push(message);
    run.status='running';
  }else if(event.event==='run.delta'){
    const index=run.messages.findIndex(message=>message.id===event.data.messageId);
    if(index<0)run.messages.push({id:event.data.messageId,role:'assistant',text:event.data.text});
    else run.messages[index]={...run.messages[index]!,text:run.messages[index]!.text+event.data.text};
  }else {
    if(event.data.messages.length)run.messages=event.data.messages;
    run.status=event.event==='run.completed'?'completed':event.event==='run.stopped'?'stopped':'failed';
  }
  return previous?runs.map(item=>item.id===runId?run:item):[...runs,run];
}
export function mergeInitial(runs:Run[],events:RunEvent[]):Run[]{
  const initialIds=new Set(runs.map(run=>run.id));
  return events.reduce((items,event)=>initialIds.has(event.data.runId)&&(event.event==='run.created'||event.event==='run.delta')?items:applyRunEvent(items,event),runs);
}
