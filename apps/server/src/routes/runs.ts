import { Hono } from 'hono';
import { z } from 'zod';
import { AgentRuntime, RuntimeError } from '../agent/runtime.js';

const input = z.object({text:z.string().min(1).max(100_000).refine(v => v.trim().length > 0),requestId:z.string().uuid(),expectedTipEntryId:z.string().min(1)}).strict();
export function runRoutes(runtime:AgentRuntime):Hono {
  const app = new Hono();
  app.post('/sessions/:id/runs',async c => {
    try {
      const body = input.parse(await c.req.json());
      const {runId,stream} = await runtime.prepare(c.req.param('id'),body.text,body.requestId,body.expectedTipEntryId,c.req.raw.signal);
      return c.body(stream,200,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-run-id':runId});
    } catch (err) {
      const code = err instanceof RuntimeError ? err.code : err instanceof Error && ['CONTEXT_BUDGET_EXCEEDED','SUMMARY_EMPTY'].includes(err.message) ? err.message : 'INVALID_REQUEST';
      const status = code === 'SESSION_NOT_FOUND' ? 404 : ['SESSION_BUSY','TIP_CONFLICT','REQUEST_ALREADY_EXISTS'].includes(code) ? 409 : 422;
      return c.json({error:{code,message:code,...(err instanceof RuntimeError && err.details ? {details:err.details} : {})}},status);
    }
  });
  app.post('/sessions/:id/stop',async c => {
    const state = await runtime.stopActive(c.req.param('id'));
    return state ? c.json(state) : c.json({error:{code:'RUN_NOT_FOUND',message:'Run not found'}},404);
  });
  app.get('/sessions/:id/runs/:runId',c => {
    const state = runtime.status(c.req.param('id'),c.req.param('runId'));
    return state ? c.json({runId:c.req.param('runId'),...state}) : c.json({error:{code:'RUN_NOT_FOUND',message:'Run not found'}},404);
  });
  app.post('/sessions/:id/runs/:runId/stop',async c => {
    const state = await runtime.stop(c.req.param('id'),c.req.param('runId'));
    return state ? c.json({runId:c.req.param('runId'),...state}) : c.json({error:{code:'RUN_NOT_FOUND',message:'Run not found'}},404);
  });
  return app;
}
