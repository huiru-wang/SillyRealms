import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { AgentRuntime, RuntimeError } from '../agent/index.js';
import { historyRuns } from '../domain/session/history-runs.js';
import { ErrorCodes } from '../common/error-codes.js';
import { failure, ok } from '../common/http-response.js';
import { UsageStore } from '../agent/persistence/usage-store.js';

const runRequest=z.object({text:z.string().min(1).max(100000).refine(value=>!!value.trim()),requestId:z.string().uuid(),expectedTipEntryId:z.string().min(1)}).strict();

/** Runtime endpoints are version-neutral; the app mounts them under V1. */
export function sessionRuntimeRoutes(db:DatabaseSync,runtime:AgentRuntime):Hono {
  const app=new Hono();
  const session=(id:string)=>db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  const usage = new UsageStore(db);
  app.get('/:id/usage', c => {
    const id = c.req.param('id');
    if (!session(id)) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND,'会话不存在'),404);
    return c.json(ok(usage.view(id)));
  });
  app.post('/:id/runs',async c=>{
    const input=runRequest.safeParse(await c.req.json().catch(()=>null));
    if(!input.success)return c.json(failure(ErrorCodes.INVALID_REQUEST,'请求无效'),400);
    try {const result=await runtime.start(c.req.param('id'),input.data.text,input.data.requestId,input.data.expectedTipEntryId);return c.json(ok({runId:result.runId,requestId:result.requestId}),202);}
    catch(error){const code=error instanceof RuntimeError?error.code:ErrorCodes.INVALID_REQUEST;const status=code==='SESSION_NOT_FOUND'?404:['WORLD_BUSY','SESSION_BUSY','TIP_CONFLICT','REQUEST_ALREADY_EXISTS'].includes(code)?409:422;return c.json({code,message:code,data:null},status);}
  });
  app.get('/:id/runs/:runId',c=>{
    const result=runtime.status(c.req.param('id'),c.req.param('runId'));
    return result?c.json(ok(result)):c.json(failure(ErrorCodes.RUN_NOT_FOUND,'运行不存在'),404);
  });
  app.post('/:id/runs/:runId/stop',async c=>{
    const result=await runtime.stop(c.req.param('id'),c.req.param('runId'));
    return result?c.json(ok(result)):c.json(failure(ErrorCodes.RUN_NOT_FOUND,'运行不存在'),404);
  });
  app.get('/:id/events',c=>{
    const id=c.req.param('id');if(!session(id))return c.json(failure(ErrorCodes.SESSION_NOT_FOUND,'会话不存在'),404);
    const encoder=new TextEncoder();let dispose=()=>{};let timer:ReturnType<typeof setInterval>;
    const stream=new ReadableStream<Uint8Array>({start(controller){
      let closed=false;
      const send=(event:string,data:unknown)=>{if(closed)return;try{if((controller.desiredSize??1)<-128){closed=true;dispose();clearInterval(timer);controller.close();return;}controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));}catch{closed=true;dispose();clearInterval(timer);}};
      const messages=(runId:string)=>{try{const row=session(id);if(!row?.tip_entry_id)return [];return historyRuns(db,id,String(row.tip_entry_id),20).runs.find(run=>run.id===runId)?.messages??[];}catch{return [];}};
      dispose=runtime.onEvent((target,event,payload)=>{
        if(target!==id)return;
        const runId=String(payload.runId??'');
        if(event==='message.created') {
          const message=payload.message as {id:string;role:string;text:string}|undefined;
          if(message?.role==='user')send('run.created',{runId,messages:[{id:message.id,role:'user',text:message.text}]});
          else if(message?.role==='assistant' && message.text)send('run.delta',{runId,messageId:message.id,text:message.text});
        } else if(event==='message.delta') send('run.delta',{runId,messageId:payload.messageId,text:payload.text});
        else if(event==='run.updated' && payload.status==='completed')send('run.completed',{runId,messages:messages(runId)});
        else if(event==='run.updated' && payload.status==='failed')send('run.failed',{runId,messages:messages(runId),error:payload.errorCode??'RUN_FAILED'});
        else if(event==='run.updated' && payload.status==='stopped')send('run.stopped',{runId,messages:messages(runId)});
        else if(event==='state.changed' && typeof payload.path==='string')send('state.changed',payload);
        else if(event==='usage.updated')send('usage.updated',payload);
      });
      timer=setInterval(()=>{try{controller.enqueue(encoder.encode(': heartbeat\n\n'));}catch{dispose();clearInterval(timer);}},15000);
    },cancel(){dispose();clearInterval(timer);}});
    return c.body(stream,200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','x-accel-buffering':'no'});
  });
  return app;
}
