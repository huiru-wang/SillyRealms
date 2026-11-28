import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { errorHandler } from '../http/response.js';
import { createNarrativeRoutes } from './narrative.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { NarrativeUsecases } from '../usecases/narrative/index.js';

const receipt = {runId:'round',userEntryId:'user',assistantEntryId:'new-ai',
  userMessage:{id:'user',role:'user',status:'complete',content:'Go',timestamp:1},tipEntryId:'user',deletedMessageIds:['old-ai']};
function setup(allowed = true) {
  const regenerate = vi.fn(() => receipt), stop = vi.fn((runId: string) => ({runId,stopping:true}));
  const routes = createNarrativeRoutes({sessions:{get:(id:string)=>id==='s'?{id}:null} as SessionService,
    narrative:{regenerate,stop} as unknown as NarrativeUsecases,canAccessSession:()=>allowed,shutdownSignal:new AbortController().signal});
  const app = new Hono().route('/sessions',routes).onError(errorHandler);
  const post = (path: string, body: unknown) => app.request('/sessions/s/narrative/runs/'+path,
    {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return {post,regenerate,stop};
}
describe('narrative mutation routes without a network listener', () => {
  it('binds regeneration to the authorized session and returns the committed receipt', async () => {
    const {post,regenerate} = setup();
    const input = {runId:'round',expectedAssistantEntryId:'old-ai',expectedTipEntryId:'old-ai'};
    const response = await post('regenerate',input);
    expect(response.status).toBe(202);expect((await response.json()).data).toEqual(receipt);
    expect(regenerate).toHaveBeenCalledWith({...input,sessionId:'s'});
    expect((await post('regenerate',{...input,sessionId:'other'})).status).toBe(400);
    expect(regenerate).toHaveBeenCalledTimes(1);
  });
  it('checks access before regeneration and never passes a foreign session to the usecase', async () => {
    const {post,regenerate} = setup(false);
    expect((await post('regenerate',{runId:'round',expectedAssistantEntryId:'a',expectedTipEntryId:'a'})).status).toBe(404);
    expect(regenerate).not.toHaveBeenCalled();
  });
  it('requires the exact execution identity in the stop body', async () => {
    const {post,stop} = setup();
    expect((await post('round/stop',{})).status).toBe(400);
    expect((await post('round/stop',{assistantEntryId:'new-ai',sessionId:'other'})).status).toBe(400);
    expect((await post('round/stop',{assistantEntryId:'new-ai'})).status).toBe(200);
    expect(stop).toHaveBeenCalledExactlyOnceWith('s','round','new-ai');
  });
});
