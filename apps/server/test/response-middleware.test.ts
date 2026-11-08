import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { responseEnvelope } from '../src/common/response-middleware.js';

it('wraps JSON success and errors while keeping export downloads raw',async()=>{
  const app=new Hono();app.use('*',responseEnvelope);
  app.get('/api/test',c=>c.json({item:{id:'a'}}));
  app.get('/api/error',c=>c.json({error:{code:'SESSION_NOT_FOUND',message:'会话不存在'}},404));
  app.get('/api/world/export',c=>c.json({spec:'world_card'}));
  app.get('/api/events',c=>c.body('event: state.changed\ndata: {}\n\n',200,{'content-type':'text/event-stream'}));
  expect(await (await app.request('/api/test')).json()).toEqual({code:'OK',message:'',data:{item:{id:'a'}}});
  const error=await app.request('/api/error');expect(error.status).toBe(404);
  expect(await error.json()).toEqual({code:'SESSION_NOT_FOUND',message:'会话不存在',data:null});
  expect(await (await app.request('/api/world/export')).json()).toEqual({spec:'world_card'});
  expect((await app.request('/api/events')).headers.get('content-type')).toContain('text/event-stream');
});
