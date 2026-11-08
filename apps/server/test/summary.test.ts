import { expect, it } from 'vitest';
import { compressHistory } from '../src/agent/context/history-compactor.js';
import type { Message } from '@earendil-works/pi-ai';

it('summarizes the oldest messages in order without discarding the tail', async () => {
  const history = Array.from({length:40}, (_, i) => ({ id:`e${i}`, role:'user' as const, text:`message ${i}` }));
  const consumed:string[] = [];
  const result = await compressHistory({ history, budget:100000, toolJson:'', build: h => h.map(x => ({role:'user',content:x.text,timestamp:0} as Message)), summarize: async request => { consumed.push(...request.chunks.map(c => c.id)); return 'summary'; } });
  expect(consumed).toEqual(history.slice(0,28).map(x => x.id));
  expect(result.summary?.coveredThroughEntryId).toBe('e27');
  expect(result.history.slice(1).map(x => x.id)).toEqual(history.slice(28).map(x => x.id));
});
