import { describe, expect, it } from 'vitest';
import { hasInputUsageReport, normalizeUsage } from './usage.js';

describe('pi usage normalization', () => {
  const valid = { input: 11, output: 5, cacheRead: 7, cacheWrite: 3, totalTokens: 26 };

  it('includes cache counters once and does not double-count reasoning', () => {
    expect(normalizeUsage({ ...valid, reasoning: 4 })).toEqual({
      inputTokens: 21, outputTokens: 5, totalTokens: 26, cacheReadTokens: 7, cacheWriteTokens: 3,
    });
  });

  it('does not mistake missing/default/output-only usage for zero cost', () => {
    expect(normalizeUsage(undefined)).toBeNull();
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    expect(normalizeUsage(zero)).toBeNull();
    expect(normalizeUsage({ ...zero, output: 2, totalTokens: 2 })).toBeNull();
    expect(normalizeUsage(zero, true)).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('rejects corrupt, unsafe and inconsistent counters rather than persisting misleading usage', () => {
    expect(normalizeUsage({ ...valid, input: -1 })).toBeNull();
    expect(normalizeUsage({ ...valid, output: NaN })).toBeNull();
    expect(normalizeUsage({ ...valid, cacheRead: '7' })).toBeNull();
    expect(normalizeUsage({ ...valid, totalTokens: 16 })).toBeNull();
    expect(normalizeUsage({ ...valid, input: Number.MAX_SAFE_INTEGER })).toBeNull();
    expect(normalizeUsage({ ...valid, output: 1.5 })).toBeNull();
  });

  it('only treats valid provider input counters as evidence, including real zero reports', () => {
    expect(hasInputUsageReport({ usage: { prompt_tokens: 0 } })).toBe(true);
    expect(hasInputUsageReport({ message: { usage: { input_tokens: 0 } } })).toBe(true);
    expect(hasInputUsageReport({ response: { usage: { input_tokens: 10 } } })).toBe(true);
    expect(hasInputUsageReport({ usageMetadata: { promptTokenCount: 10 } })).toBe(true);
    expect(hasInputUsageReport({ usage: { output_tokens: 10 } })).toBe(false);
    expect(hasInputUsageReport({ usage: { prompt_tokens: -1 } })).toBe(false);
    expect(hasInputUsageReport(null)).toBe(false);
  });
});
