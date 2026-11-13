import { publicRunResult } from '../domain/session/run-result.js';
import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { SRRuntime } from '../runtime/index.js';
import { ErrorCodes, errorInfo, isErrorCode, normalizeError, type ErrorCode } from '../common/error-codes.js';
import { failure, ok } from '../common/http-response.js';
import { UsageStore } from '../runtime/persistence/usage-store.js';

const runRequest=z.object({text:z.string().min(1).max(100000).refine(value=>!!value.trim()),requestId:z.string().uuid(),expectedTipEntryId:z.string().min(1)}).strict();

/** Runtime endpoints are version-neutral; the app mounts them under V1. */
export function sessionRuntimeRoutes(db:DatabaseSync,runtime:SRRuntime):Hono {
  const app=new Hono();
  const session=(id:string)=>db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  const usage = new UsageStore(db);
  app.get('/:id/usage', c => {
    c.header('Cache-Control','no-store');
    const id = c.req.param('id');
    if (!session(id)) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    return c.json(ok(usage.view(id)));
  });
  app.get('/:id/runs', c => {
    const id=c.req.param('id'), row=session(id);
    if (!row) return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    try { return c.json(ok(runtime.history(id,String(row.tip_entry_id),Number(c.req.query('limit') ?? 20),c.req.query('cursor')))); }
    catch (error) {
      if (error instanceof Error && error.message === ErrorCodes.INVALID_CURSOR) return c.json(failure(ErrorCodes.INVALID_CURSOR),400);
      return c.json(failure(ErrorCodes.INVALID_PARENT_CHAIN),422);
    }
  });
  app.post('/:id/runs',async c=>{
    const input=runRequest.safeParse(await c.req.json().catch(()=>null));
    if(!input.success)return c.json(failure(ErrorCodes.INVALID_REQUEST),400);
    try {const result=await runtime.start(c.req.param('id'),input.data.text,input.data.requestId,input.data.expectedTipEntryId);return c.json(ok({runId:result.runId,requestId:result.requestId}),202);}
    catch(error){
      const { errorCode } = normalizeError(error);
      const status = errorCode === ErrorCodes.SESSION_NOT_FOUND ? 404
        : new Set<ErrorCode>([ErrorCodes.WORLD_BUSY, ErrorCodes.SESSION_BUSY, ErrorCodes.TIP_CONFLICT, ErrorCodes.REQUEST_ALREADY_EXISTS]).has(errorCode) ? 409
          : errorCode === ErrorCodes.INTERNAL_ERROR ? 500 : 422;
      return c.json(failure(errorCode), status);
    }
  });
  app.get('/:id/runs/:runId',c=>{
    const result=runtime.status(c.req.param('id'),c.req.param('runId'));
    return result?c.json(ok(result)):c.json(failure(ErrorCodes.RUN_NOT_FOUND),404);
  });
  app.post('/:id/runs/:runId/stop',async c=>{
    const result=await runtime.stop(c.req.param('id'),c.req.param('runId'));
    return result?c.json(ok(result)):c.json(failure(ErrorCodes.RUN_NOT_FOUND),404);
  });
  app.get('/:id/events',c=>{
    const id=c.req.param('id');if(!session(id))return c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404);
    const encoder=new TextEncoder();let dispose=()=>{};let timer:ReturnType<typeof setInterval>;
    const stream=new ReadableStream<Uint8Array>({start(controller){
      let closed=false;
      const send=(event:string,data:unknown)=>{if(closed)return;try{if((controller.desiredSize??1)<-128){closed=true;dispose();clearInterval(timer);controller.close();return;}controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));}catch{closed=true;dispose();clearInterval(timer);}};
      const messages=(runId:string)=>runtime.status(id,runId)?.messages??[];
      dispose=runtime.onEvent((target,event,payload)=>{
        if(target!==id)return;
        const runId=String(payload.runId??'');
        const publicResult=()=>{
          const { input: _input, ...result } = (runtime.status(id,runId)??publicRunResult({...payload,runId})) as Record<string, unknown>;
          return result;
        };
        if(event==='message.created') {
          const message=payload.message as {id:string;role:string;text:string}|undefined;
          if(message?.role==='user')send('run.created',{...publicResult(),runId,messages:[{id:message.id,role:'user',text:message.text}]});
          else if(message?.role==='assistant' && message.text)send('run.delta',{runId,messageId:message.id,offset:0,text:message.text});
        } else if(event==='message.delta') send('run.delta',{runId,messageId:payload.messageId,offset:payload.offset,text:payload.text});
        else if(event==='run.updated' && payload.status==='completed')send('run.completed',{...publicResult(),runId,messages:messages(runId)});
        else if(event==='run.updated' && payload.status==='failed') {
          const code = isErrorCode(payload.errorCode) ? payload.errorCode : ErrorCodes.INTERNAL_ERROR;
          send('run.failed',{
            ...publicResult(), runId, messages: messages(runId), errorCode: code,
            errorMessage: typeof payload.errorMessage === 'string' && payload.errorMessage
              ? payload.errorMessage : errorInfo(code).errorMessage,
          });
        } else if(event==='run.updated' && payload.status==='stopped')send('run.stopped',{...publicResult(),runId,messages:messages(runId)});
        else if(event==='state.changed' && typeof payload.path==='string')send('state.changed',payload);
        else if(event==='tool.failed')send('tool.failed',payload);
        else if(event==='run.phase')send('run.phase',{runId,phase:payload.phase});
        else if(event==='usage.updated')send('usage.updated',payload);
      });
      timer=setInterval(()=>{try{controller.enqueue(encoder.encode(': heartbeat\n\n'));}catch{dispose();clearInterval(timer);}},15000);
    },cancel(){dispose();clearInterval(timer);}});
    return c.body(stream,200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','x-accel-buffering':'no'});
  });
  return app;
}
