import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../studio/src/api.js';

afterEach(() => vi.unstubAllGlobals());

it('unwraps only the successful data payload', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    success:true,errorCode:null,errorMessage:'',data:{id:'s1',ok:true},
  }), {status:200,headers:{'content-type':'application/json'}}));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api('v1/sessions/s1')).toEqual({id:'s1',ok:true});
  expect(fetchMock).toHaveBeenCalledWith('/api/v1/sessions/s1', expect.any(Object));
});

it('throws the new error fields instead of legacy message/code', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    success:false,errorCode:'CONTEXT_BUDGET_EXCEEDED',
    errorMessage:'上下文超出模型允许范围：最大支持 128K Token',
    data:null,
  }), {status:422,headers:{'content-type':'application/json'}})));
  try {
    await api('v1/sessions/s1/runs');
    throw new Error('expected to reject');
  } catch(error) {
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      errorCode:'CONTEXT_BUDGET_EXCEEDED',
      errorMessage:'上下文超出模型允许范围：最大支持 128K Token',
    });
  }
});

it('rejects malformed or legacy server envelopes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    code:'INVALID_REQUEST',message:'old contract',data:null,
  }), {status:400,headers:{'content-type':'application/json'}})));
  await expect(api('v1/sessions')).rejects.toMatchObject({errorCode:'INVALID_RESPONSE'});
});

it.each([500,502,503,504])('reports proxy HTTP %s as server unavailable',async status=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status})));
  await expect(api('v1/sessions')).rejects.toMatchObject({errorCode:'SERVER_UNAVAILABLE',message:expect.stringContaining('服务器暂时不可用')});
});

it('reports network failures without retrying a send',async()=>{
  const request=vi.fn(async()=>{throw new TypeError('Failed to fetch');});
  vi.stubGlobal('fetch',request);
  await expect(api('v1/sessions/s/runs',{method:'POST'})).rejects.toMatchObject({errorCode:'SERVER_UNAVAILABLE'});
  expect(request).toHaveBeenCalledTimes(1);
});

it('preserves explicit cancellation and valid server errors',async()=>{
  const cancelled=new DOMException('Cancelled','AbortError');
  vi.stubGlobal('fetch',vi.fn(async()=>{throw cancelled;}));
  await expect(api('v1/sessions')).rejects.toBe(cancelled);
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({success:false,errorCode:'INTERNAL_ERROR',errorMessage:'服务正在重启',data:null}),{status:503})));
  await expect(api('v1/sessions')).rejects.toMatchObject({errorCode:'INTERNAL_ERROR',message:'服务正在重启'});
});

it('still rejects a malformed successful response',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>fallback</html>')));
  await expect(api('v1/sessions')).rejects.toMatchObject({errorCode:'INVALID_RESPONSE'});
});
