import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { responseEnvelope } from '../src/common/response-middleware.js';
import { failure } from '../src/common/http-response.js';
import { ErrorCodes } from '../src/common/error-codes.js';

it('wraps JSON success and errors while keeping export downloads raw',async()=>{
  const app=new Hono();app.use('*',responseEnvelope);
  app.get('/api/test',c=>c.json({item:{id:'a'}}));
  app.get('/api/error',c=>c.json(failure(ErrorCodes.SESSION_NOT_FOUND),404));
  app.get('/api/world/export',c=>c.json({spec:'world_card'}));
  app.get('/api/events',c=>c.body('event: state.changed\ndata: {}\n\n',200,{'content-type':'text/event-stream'}));
  expect(await (await app.request('/api/test')).json()).toEqual({success:true,errorCode:null,errorMessage:'',data:{item:{id:'a'}}});
  const error=await app.request('/api/error');expect(error.status).toBe(404);
  expect(await error.json()).toEqual({success:false,errorCode:'SESSION_NOT_FOUND',errorMessage:'会话不存在',data:null});
  expect(await (await app.request('/api/world/export')).json()).toEqual({spec:'world_card'});
  expect((await app.request('/api/events')).headers.get('content-type')).toContain('text/event-stream');
});
