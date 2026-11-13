import { expect, it } from 'vitest';
import { rollingSummary } from '../src/runtime/context/compaction/rolling-summary.js';
import { selectSuffix } from '../src/runtime/context/compaction/sliding-window.js';
import { historyGroups } from '../src/runtime/context/compaction/history.js';
import type { CompactionInput } from '../src/runtime/context/compaction/types.js';
const history = Array.from({ length: 6 }, (_, i) => [
  { id: `u${i}`, role: 'user' as const, text: 'user' }, { id: `a${i}`, role: 'assistant' as const, text: 'assistant' },
]).flat();
it('summarizes a continuous prefix once, with the previous summary and five protected turns', async () => {
  const requests: unknown[] = [];
  const input = { history, oldSummary: { text: 'previous', coveredThroughEntryId: 'prior' }, policy: { keepRecentTurns: 5 },
    summarize: async (previous: string | null, chunks: unknown) => { requests.push({ previous, chunks }); return 'combined'; } } as CompactionInput;
  const result = await rollingSummary(input, history, 0);
  expect(requests).toEqual([{ previous: 'previous', chunks: history.slice(0, 2) }]);
  expect(result?.summary.coveredThroughEntryId).toBe('a0');
  expect(result?.kept).toEqual(history.slice(2));
  expect(await rollingSummary(input, history.slice(2), 0)).toBeUndefined();
});
it('keeps an opening as a separate group and never skips a neighboring oversized turn', () => {
  const opening = { id: 'opening', role: 'assistant' as const, text: 'opening' };
  expect(historyGroups([opening, ...history])).toHaveLength(7);
  const selected = selectSuffix([opening, ...history, { id: 'big', role: 'user', text: 'x'.repeat(10000) }], 100);
  expect(selected.kept).toEqual([]);
});
