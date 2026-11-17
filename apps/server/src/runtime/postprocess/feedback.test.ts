import {afterEach,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {serveWebConfig} from '../../infrastructure/http/stage-assets.js';
import {isPostprocessError,postprocessFeedback} from '../../../../../packages/sr-sdk/src/postprocess-feedback.js';
import type {Run,RunExtensions} from '../../../../../packages/sr-sdk/src/run-contract.js';

afterEach(()=>vi.unstubAllEnvs());
const run=(state:RunExtensions['stateUpdate']['status'],suggestions:RunExtensions['actionSuggestions']['status']):Run=>({id:'run',status:'completed',messages:[],extensions:{stateUpdate:{status:state},actionSuggestions:{status:suggestions}}});

it.each(['partial','failed'] as const)('hides %s state and suggestion diagnostics unless DEBUG is explicitly enabled',state=>{
  expect(postprocessFeedback(run(state,'failed'))).toEqual([]);
  expect(postprocessFeedback(run(state,'failed'),false)).toEqual([]);
  expect(postprocessFeedback(run(state,'failed'),true)).toHaveLength(2);
  const messages=postprocessFeedback(run(state,'ready'),true);
  expect(messages).toHaveLength(1);
  expect(messages.join('')).not.toContain('不提供行动建议');
});
it('shows no plugin errors when both plugins succeed',()=>{
  expect(postprocessFeedback(run('applied','ready'),true)).toEqual([]);
});
it.each(['1','0','true',''])('exposes only explicit SILLYREALMS_DEBUG=1 through the runtime config (%s)',async value=>{
  vi.stubEnv('SILLYREALMS_DEBUG',value);
  const app=new Hono(),stage={origin:null,port:3001,entryPath:'/frame.html' as const};
  serveWebConfig(app,stage);
  const response=await app.request('/api/v1/runtime/web-config');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({stage,debug:value==='1'});
});
it('distinguishes plugin diagnostics from run and persistence failures for Host notices',()=>{
  for(const code of ['EXTENSION_PROTOCOL_INVALID','EXTENSION_TAIL_TOO_LARGE','STATE_UPDATE_MISSING','STATE_UPDATE_INVALID','INVALID_STATE_UPDATE','ACTION_SUGGESTIONS_INVALID'])expect(isPostprocessError(code)).toBe(true);
  for(const code of ['PROVIDER_ERROR','STATE_COMMIT_FAILED','RUN_INTERRUPTED',undefined])expect(isPostprocessError(code)).toBe(false);
});
