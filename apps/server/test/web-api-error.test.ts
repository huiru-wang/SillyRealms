import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../web/src/api.js';

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
