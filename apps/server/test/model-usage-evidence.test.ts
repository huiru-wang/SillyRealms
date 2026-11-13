import { afterEach, expect, it, vi } from 'vitest';
import { PiGateway, providerErrorCode } from '../src/runtime/model/pi-gateway.js';
import { runtimeFixture, textGateway, tail, response, drain } from './fixtures/runtime-v2.js';
import { UsageStore } from '../src/runtime/persistence/usage-store.js';
afterEach(()=>vi.unstubAllGlobals());
it.each([true,false])('distinguishes an explicitly reported zero from an SDK default zero (reported=%s)',async reported=>{
  const gateway=new PiGateway(),model=gateway.resolve('deepseek','deepseek-flash')!;
  const transport=vi.fn(async()=>{
    const chunks=[{id:'zero',object:'chat.completion.chunk',created:1,model:model.id,
      choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:'stop'}],
      ...(reported?{usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}:{})}];
    return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  });vi.stubGlobal('fetch',transport);
  const context={messages:[{role:'user' as const,content:'hello',timestamp:0}]};
  const fingerprint=await gateway.preview({...model,id:'no-model-specific-tokenizer'},context,{maxTokens:64});
  expect(fingerprint).toBeTruthy();expect(transport).not.toHaveBeenCalled();
  let done=false;
  for await(const event of gateway.stream(model,context,{apiKey:'offline-fake',signal:new AbortController().signal,maxTokens:64})){
    if(event.type==='done'){done=true;expect(gateway.usageReported(event.message)).toBe(reported);}
  }
  expect(done).toBe(true);expect(transport).toHaveBeenCalledTimes(1);
});
it.each([true,false])('writes a reusable input baseline only for reported usage (reported=%s)',async reported=>{
  const gateway=textGateway('unused');gateway.usageReported=()=>reported;
  gateway.stream=()=>({async *[Symbol.asyncIterator](){const message=response('story'+tail());
    message.usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    yield {type:'done' as const,reason:'stop' as const,message};
  }});
  const {db,runtime}=runtimeFixture(gateway);
  try{
    const run=await runtime.prepare('session','PRIVATE INPUT','usage','opening');await drain(run.stream);
    const usage=JSON.parse(String(db.prepare('SELECT usage_json FROM sessions').get()!.usage_json));
    expect(!!usage.latestContext?.baseline).toBe(reported);
    expect(usage.cumulative).toMatchObject({reportedCount:reported?1:0,unknownCount:reported?0:1,inputTokens:0});
    expect(JSON.stringify(new UsageStore(db).view('session'))).not.toContain('baseline');
    expect(JSON.stringify(usage)).not.toContain('PRIVATE INPUT');
  }finally{db.close();}
});
it.each(['throw','terminal'] as const)('classifies known Provider overflow through %s and preserves real usage',async kind=>{
  const gateway=textGateway('unused');gateway.stream=()=>({async *[Symbol.asyncIterator](){
    if(kind==='throw')throw {error:{code:'context_length_exceeded',message:'PRIVATE UPSTREAM'}};
    yield {type:'error' as const,reason:'error' as const,error:{...response('','error'),errorMessage:JSON.stringify({error:{code:'context_length_exceeded',message:'PRIVATE UPSTREAM'}})}};
  }});
  const {db,runtime}=runtimeFixture(gateway);
  try{
    const run=await runtime.prepare('session','go','overflow','opening');await drain(run.stream);
    const status=runtime.status('session',run.runId);
    expect(status).toMatchObject({status:'failed',errorCode:'PROVIDER_CONTEXT_WINDOW_EXCEEDED',failure:{stage:'generation',type:'context_window'},recovery:{inputSaved:true,action:'adjust_configuration'}});
    expect(JSON.stringify(status)).not.toContain('PRIVATE UPSTREAM');
    expect(new UsageStore(db).view('session').cumulative).toMatchObject({reportedCount:kind==='terminal'?1:0,unknownCount:kind==='throw'?1:0});
  }finally{db.close();}
});
it('does not infer context overflow from arbitrary prose or an output-only limit',()=>{
  expect(providerErrorCode({errorMessage:'context length exceeded PRIVATE'})).toBe('PROVIDER_ERROR');
  expect(providerErrorCode({code:'max_tokens_exceeded'})).toBe('PROVIDER_ERROR');
});
it('preserves the known overflow code from a real Pi HTTP error body without retrying',async()=>{
  const gateway=new PiGateway(),model=gateway.resolve('deepseek','deepseek-flash')!;
  const transport=vi.fn(async()=>new Response(JSON.stringify({error:{code:'context_length_exceeded',type:'invalid_request_error',message:'PRIVATE REQUEST DETAIL'}}),
    {status:400,headers:{'content-type':'application/json'}}));vi.stubGlobal('fetch',transport);
  let failed=false;
  for await(const event of gateway.stream(model,{messages:[{role:'user',content:'go',timestamp:0}]},{apiKey:'offline-fake',signal:new AbortController().signal,maxTokens:64})){
    if(event.type==='error'){failed=true;expect(providerErrorCode(event.error)).toBe('PROVIDER_CONTEXT_WINDOW_EXCEEDED');expect(gateway.usageReported(event.error)).toBe(false);}
  }
  expect(failed).toBe(true);expect(transport).toHaveBeenCalledTimes(1);
});
it('does not establish an input baseline from an output-only Provider usage report',async()=>{
  const gateway=new PiGateway(),model=gateway.resolve('deepseek','deepseek-flash')!;
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('data: '+JSON.stringify({id:'partial-usage',object:'chat.completion.chunk',created:1,model:model.id,
    choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:'stop'}],usage:{completion_tokens:2,total_tokens:2}})+'\n\ndata: [DONE]\n\n',
    {headers:{'content-type':'text/event-stream'}})));
  let done=false;
  for await(const event of gateway.stream(model,{messages:[{role:'user',content:'go',timestamp:0}]},{apiKey:'offline-fake',signal:new AbortController().signal,maxTokens:64})){
    if(event.type==='done'){done=true;expect(gateway.usageReported(event.message)).toBe(false);}
  }
  expect(done).toBe(true);
});
