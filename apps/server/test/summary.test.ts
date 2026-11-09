import { expect, it } from 'vitest';
import { compressHistory } from '../src/agent/context/history-compactor.js';

it('summarizes the oldest messages in order without discarding the tail', async () => {
  const history = Array.from({length:40}, (_, i) => ({ id:`e${i}`, role:'user' as const, text:`message ${i}` }));
  const consumed:string[] = [];
  const result = await compressHistory({ history, shouldCompact:true, summarize: async request => { consumed.push(...request.chunks.map(c => c.id)); return 'summary'; } });
  expect(consumed).toEqual(history.slice(0,35).map(x => x.id));
  expect(result.summary?.coveredThroughEntryId).toBe('e34');
  expect(result.history.slice(1).map(x => x.id)).toEqual(history.slice(35).map(x => x.id));
});

it('keeps complete turns, carries forward the old summary, and leaves short histories untouched', async () => {
  const history = Array.from({length:6}, (_, i) => [
    {id:`u${i}`,role:'user' as const,text:'user'},
    {id:`a${i}`,role:'assistant' as const,text:'assistant'},
  ]).flat();
  const requests: unknown[] = [];
  const summarize = async (request: unknown) => { requests.push(request); return 'combined'; };
  const oldSummary = {text:'old',coveredThroughEntryId:'old-entry'};
  expect((await compressHistory({history,oldSummary,shouldCompact:false,summarize})).summary).toBeUndefined();
  expect((await compressHistory({history:history.slice(2),oldSummary,shouldCompact:true,summarize})).summary).toBeUndefined();
  const result = await compressHistory({history,oldSummary,shouldCompact:true,summarize});
  expect(requests).toEqual([{previous:'old',chunks:history.slice(0,2)}]);
  expect(result.summary?.coveredThroughEntryId).toBe('a0');
  expect(result.history.slice(1)).toEqual(history.slice(2));
});
