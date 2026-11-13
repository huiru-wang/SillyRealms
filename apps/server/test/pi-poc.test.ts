import { describe, expect, it, vi } from 'vitest';
import { PiGateway, requiredToolChoice } from '../src/runtime/model/pi-gateway.js';
import { stateTool } from '../src/runtime/tools/state-tool.js';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { Model } from '@earendil-works/pi-ai';

const model: Model<'openai-completions'> = {
  id: 'mock', name: 'Mock', api: 'openai-completions', provider: 'openai',
  baseUrl: 'http://localhost:12345/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024,
  compat: { supportsMidConvoSystemMessages: true },
};

describe('Pi SDK contract PoC', () => {
  it('preserves system message order and current user, and streams text and tool call', async () => {
    let payload: Record<string, unknown> | undefined;
    const chunks = [
      { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
      { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'update_state', arguments: '{"path":"x","value":1}' } }] }, finish_reason: null }] },
      { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    const mockFetch: typeof fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const stream = streamSimple(model, normalizeContext({ messages: [
      { role: 'system', content: 'first', timestamp: 1 },
      { role: 'user', content: 'input', timestamp: 2 },
      { role: 'system', content: 'last', timestamp: 3 },
    ], tools: [{ name: 'update_state', description: 'Set a value', parameters: { type: 'object', properties: { path: { type: 'string' }, value: { type: 'number' } }, required: ['path', 'value'] } }] }), { apiKey: 'dummy', fetch: mockFetch });
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    const messages = payload?.messages as Array<{role: string; content: string}>;
    expect(messages.map(m => m.role)).toEqual(['system', 'user', 'system']);
    expect(messages.filter(m => m.content === 'input')).toHaveLength(1);
    expect(types).toContain('text_delta');
    expect(types).toContain('toolcall_end');
    const result = await stream.result();
    expect(result.content.map(part => part.type)).toEqual(['text', 'toolCall']);
  });
  it('detects SDK system-message collapsing when the provider lacks mid-conversation support', async () => {
    let payload: Record<string, unknown> | undefined;
    const chunks = [{ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }] }, { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
    const mockFetch: typeof fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    const incompatibleModel = { ...model, compat: { supportsMidConvoSystemMessages: false } };
    const stream = streamSimple(incompatibleModel, normalizeContext({ messages: [
      { role: 'system', content: 'first', timestamp: 1 },
      { role: 'user', content: 'input', timestamp: 2 },
      { role: 'system', content: 'last', timestamp: 3 },
    ] }), { apiKey: 'dummy', fetch: mockFetch });
    for await (const _event of stream) { /* drain */ }
    const messages = payload?.messages as Array<{role: string; content: string}>;
    expect(messages.map(m => m.role)).toEqual(['system', 'user']);
    expect(JSON.stringify(messages[0])).toContain('last');
  });
  it('uses the real Pi gateway and explicitly supplied credentials with a fake transport', async () => {
    const gateway=new PiGateway(); const selected=gateway.resolve('deepseek','deepseek-flash');
    expect(selected).toBeDefined();
    let wasCalled=false; let sentBody:unknown;
    const oldDebug=process.env.SILLYREALMS_DEBUG; process.env.SILLYREALMS_DEBUG='1';
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});
    const chunks=[{id:'test',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}]},{id:'test',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{},finish_reason:'stop'}]}];
    vi.stubGlobal('fetch',async (_input:unknown,init:RequestInit) => { wasCalled=true; sentBody=JSON.parse(String(init.body)); return new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}); });
    try {
      const events=[];
      for await (const event of gateway.stream(selected!,{messages:[{role:'user',content:'hello',timestamp:0}],tools:[stateTool]},{apiKey:'fake',signal:new AbortController().signal,maxTokens:20,toolChoice:requiredToolChoice(selected!)})) events.push(event.type);
      expect(wasCalled).toBe(true); expect(events).toContain('text_delta'); expect(events).toContain('done');
      expect(sentBody).toMatchObject({tool_choice:'required'});
      const output=String(log.mock.calls[0]?.[0]); const logged=JSON.parse(output.split(' | ')[1]!);
      expect(logged).toMatchObject({provider:'deepseek',model:'deepseek-flash',fingerprint:expect.any(String)});
      expect(logged.payload).toEqual(sentBody);
      expect(logged.payload.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'user',content:'hello'})]));
      expect(output).not.toMatch(/[\r\n]/);
      expect(JSON.stringify(logged)).not.toContain('fake');
    } finally { if(oldDebug===undefined)delete process.env.SILLYREALMS_DEBUG;else process.env.SILLYREALMS_DEBUG=oldDebug;log.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('replays tool calls and results in order to the provider transport', async () => {
    let payload:Record<string,unknown>|undefined;
    const mockFetch:typeof fetch=async (_input,init)=>{
      payload=JSON.parse(String(init?.body)) as Record<string,unknown>;
      const chunks=[{id:'t',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{role:'assistant',content:'ok'},finish_reason:null}]},{id:'t',object:'chat.completion.chunk',created:1,model:'mock',choices:[{index:0,delta:{},finish_reason:'stop'}]}];
      return new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    };
    const context=normalizeContext({messages:[
      {role:'user',content:'go',timestamp:0},
      {role:'assistant',content:[{type:'toolCall',id:'call_1',name:'update_state',arguments:{path:'x',value:1}}],api:'openai-completions',provider:'openai',model:'mock',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:0},
      {role:'toolResult',toolCallId:'call_1',toolName:'update_state',content:[{type:'text',text:'{\"ok\":true}'}],isError:false,timestamp:0},
    ],tools:[{name:'update_state',description:'Set state',parameters:{type:'object',properties:{path:{type:'string'},value:{type:'number'}}}}]});
    const stream=streamSimple(model,context,{apiKey:'fake',fetch:mockFetch});
    for await (const _event of stream) { /* drain */ }
    const messages=payload?.messages as Array<{role:string;tool_call_id?:string}>;
    expect(messages.map(m=>m.role)).toEqual(['user','assistant','tool']);
    expect(messages[2]?.tool_call_id).toBe('call_1');
  });
  it('records tool capability only after a successful tool probe', async () => {
    const gateway=new PiGateway();expect(gateway.toolVerified('deepseek','deepseek-flash')).toBe(false);
    const chunks=[{id:'test',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'update_state',arguments:'{\"updates\":[{\"path\":\"test.value\",\"value\":1}]}'}}]},finish_reason:null}]},{id:'test',object:'chat.completion.chunk',created:1,model:'deepseek-flash',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}];
    vi.stubGlobal('fetch',async()=>new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}));
    try { expect(await gateway.verify('deepseek','deepseek-flash','fake')).toBe(true); expect(gateway.toolVerified('deepseek','deepseek-flash')).toBe(true); }
    finally { vi.unstubAllGlobals(); }
  });
  it('propagates an abort signal through the SDK stream', async () => {
    const controller=new AbortController();
    const mockFetch:typeof fetch=async (_input,init)=>new Promise((_resolve,reject)=>{
      const signal=init?.signal;
      if (signal?.aborted) reject(new DOMException('Aborted','AbortError'));
      else signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    });
    const stream=streamSimple(model,normalizeContext({messages:[{role:'user',content:'hi',timestamp:0}]}),{apiKey:'fake',fetch:mockFetch,signal:controller.signal,maxRetries:0});
    const seen:string[]=[];
    const consuming=(async()=>{for await (const event of stream) seen.push(event.type==='error' ? event.reason : event.type);})();
    controller.abort(); await consuming;
    expect(seen).toContain('aborted');
  });
  it('exposes an offline model directory', () => {
    const catalog = builtinModels();
    expect(catalog.getProviders().length).toBeGreaterThan(0);
    expect(catalog.getModels('openai').length).toBeGreaterThan(0);
  });
});
