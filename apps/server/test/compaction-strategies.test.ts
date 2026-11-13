import { expect, it, vi } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import { prepareForRun } from '../src/runtime/context/compaction/index.js';
import { estimateContext, estimateText, estimateInitial, inputIdentity } from '../src/runtime/context/compaction/estimator.js';
import type { CompactionInput } from '../src/runtime/context/compaction/types.js';
import type { HistoryItem } from '../src/runtime/context/compaction/history.js';
import { testModel, response } from './fixtures/runtime-v2.js';
import { budgetInputSchema, mergeBudget, publicBudget, resolveBudget } from '../src/domain/preset-budget.js';

function fixture(strategy: 'rolling_summary' | 'sliding_window', history: HistoryItem[]): CompactionInput {
  const preview = (items: HistoryItem[]): Context => ({ messages: [
    { role: 'system', content: 'fixed instruction', timestamp: 0 },
    ...items.map(item => item.role === 'assistant' ? response(item.text) : { role: 'user' as const, content: item.text, timestamp: 0 }),
    { role: 'user', content: 'current input', timestamp: 0 },
  ] });
  return { history, policy: { budget: { strategy, max_context_tokens: 1000, max_output_tokens: 128 },
    safetyMarginTokens: 1024, keepRecentTurns: 5, summary: { inputRatio: .75, maxOutputTokens: 2048 } },
    preview, identity: context => inputIdentity(testModel, context, { mode: 'direct', strategy }),
    summarize: vi.fn(async () => 'concise summary') };
}
const turns = (count: number, size = 600): HistoryItem[] => Array.from({ length: count }, (_, i) => [
  { id: 'u' + i, role: 'user' as const, text: 'u'.repeat(size) },
  { id: 'a' + i, role: 'assistant' as const, text: 'a'.repeat(size) },
]).flat();
it('triggers at exactly 100%, targets 60%, and retains the largest fitting continuous suffix', async () => {
  const input = fixture('sliding_window', turns(8));
  const exact = estimateContext(input.preview(input.history));
  input.policy.budget.max_context_tokens = exact + 1;
  expect((await prepareForRun(input)).report.triggered).toBe(false);
  input.policy.budget.max_context_tokens = exact;
  const result = await prepareForRun(input);
  expect(result.report).toMatchObject({ triggered: true, target: Math.floor(exact * .6), outcome: 'trimmed' });
  expect(result.report.estimatedInputAfter).toBeLessThanOrEqual(result.report.target);
  const first = input.history.findIndex(item => item.id === result.history[0]!.id);
  expect(result.history).toEqual(input.history.slice(first));
  expect(estimateContext(input.preview(input.history.slice(first - 2)))).toBeGreaterThan(result.report.target);
  expect(input.summarize).not.toHaveBeenCalled();
});
it('restores raw history when the sliding allowance grows or a prior summary is ignored', async () => {
  const input = fixture('sliding_window', turns(8));
  input.oldSummary = { text: 'old summary', coveredThroughEntryId: 'a5' };
  const small = await prepareForRun(input);
  expect(small.history.length).toBeLessThan(input.history.length);
  input.policy.budget.max_context_tokens = 10000;
  expect((await prepareForRun(input)).history).toEqual(input.history);
  input.policy.budget.strategy = 'rolling_summary';
  expect((await prepareForRun(input)).history.map(h => h.id)).toEqual(['summary', 'u6', 'a6', 'u7', 'a7']);
});
it('can omit every old turn while preserving oversized fixed content', async () => {
  const input = fixture('sliding_window', turns(8));
  input.policy.budget.max_context_tokens = 100;
  const result = await prepareForRun(input);
  expect(result.history).toEqual([]);
  expect(result.report).toMatchObject({ reason: 'protected_over_target', targetExceeded: true });
});
it('summarizes one continuous prefix once, protects five turns and allows a result above target', async () => {
  const input = fixture('rolling_summary', turns(8));
  input.oldSummary = { text: 'previous summary', coveredThroughEntryId: 'a0' };
  const result = await prepareForRun(input);
  expect(input.summarize).toHaveBeenCalledExactlyOnceWith('previous summary', input.history.slice(2, 6));
  expect(result.summary).toMatchObject({ coveredThroughEntryId: 'a2', firstKeptEntryId: 'u3' });
  expect(result.history.slice(1)).toEqual(input.history.slice(6));
  expect(result.report).toMatchObject({ outcome: 'summarized', targetExceeded: true, reason: 'protected_over_target' });
});
it('keeps the original projection when a valid summary gives no reduction', async () => {
  const input = fixture('rolling_summary', turns(6, 50));
  input.policy.budget.max_context_tokens = 100;
  input.summarize = vi.fn(async () => 'long '.repeat(500));
  const result = await prepareForRun(input);
  expect(result.summary).toBeUndefined(); expect(result.history).toEqual(input.history);
  expect(result.report).toMatchObject({ outcome: 'skipped', reason: 'no_reduction' });
});
it('reuses real usage only for a proven prefix and rejects changes in instructions, tools or history', () => {
  const input = fixture('sliding_window', turns(2));
  const context = input.preview(input.history), identity = input.identity(context);
  const baseline = { ...identity, inputTokens: 123 };
  const appended: Context = { messages: [...context.messages, { role: 'user', content: 'abc', timestamp: 0 }] };
  expect(estimateInitial(appended, input.identity(appended), baseline)).toEqual({ tokens: 140, method: 'usage_plus_estimate' });
  for (const changed of [{ ...context, systemPrompt: 'changed' }, { ...context, messages: context.messages.slice(1) },
    { ...context, tools: [{ name: 'new', description: 'tool', parameters: { type: 'object' } }] }] as Context[]) {
    expect(estimateInitial(changed, input.identity(changed), baseline).method).toBe('full_estimate');
  }
  expect(estimateInitial(context, { ...identity, settings: 'different model or strategy' }, baseline).method).toBe('full_estimate');
  expect(estimateText('abc汉😀')).toBe(6);
});
it('preserves legacy provenance only internally and validates explicit model caps', () => {
  const old = mergeBudget({ context_strategy: 'compact', max_output_tokens: 100 }, { max_output_tokens: 200 });
  expect(old).toMatchObject({ legacyWindow: 131072, max_context_tokens: 129848 });
  expect(publicBudget(old)).not.toHaveProperty('legacyWindow');
  const explicit = mergeBudget(old, { strategy: 'sliding_window', max_context_tokens: 25000 });
  expect(explicit).not.toHaveProperty('legacyWindow');
  expect(resolveBudget(explicit, { contextWindow: 32768, maxTokens: 4096 })).toEqual(explicit);
  expect(() => resolveBudget(explicit, { contextWindow: 16000, maxTokens: 4096 })).toThrow();
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(budgetInputSchema.safeParse({ max_context_tokens: value, max_output_tokens: 100 }).success).toBe(false);
  }
  expect(budgetInputSchema.safeParse({ ...explicit, legacyWindow: 131072 }).success).toBe(false);
  expect(() => mergeBudget(old, { context_strategy: 'compact', max_context_tokens: 100 })).toThrow();
});
