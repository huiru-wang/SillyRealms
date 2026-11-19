export type PiUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}
function tokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** SDK responses start with zero counters. A provider input counter establishes a real zero report. */
export function hasInputUsageReport(event: unknown): boolean {
  const value = record(event);
  if (!value) return false;
  const usage = record(value.usage) ?? record(record(value.message)?.usage)
    ?? record(record(value.response)?.usage) ?? record(value.usageMetadata);
  return usage !== undefined && ['prompt_tokens', 'input_tokens', 'promptTokenCount']
    .some(key => tokens(usage[key]));
}

/** Cached input is part of total input; reasoning is already included in output. */
export function normalizeUsage(usage: unknown, reported = false): PiUsage | null {
  const value = record(usage);
  if (!value) return null;
  const { input, output, cacheRead, cacheWrite, totalTokens } = value;
  if (!tokens(input) || !tokens(output) || !tokens(cacheRead) || !tokens(cacheWrite) || !tokens(totalTokens)) return null;
  if (!reported && input === 0 && cacheRead === 0 && cacheWrite === 0) return null;
  const inputTokens = input + cacheRead + cacheWrite;
  const expectedTotal = inputTokens + output;
  if (!tokens(inputTokens) || !tokens(expectedTotal) || totalTokens !== expectedTotal) return null;
  return { inputTokens, outputTokens: output, totalTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}
