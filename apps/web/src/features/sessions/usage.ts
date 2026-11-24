import {i18n} from '../../i18n/instance.ts';
export type TokenTotals = {
  inputTokens: number; outputTokens: number; totalTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
};
export type ContextComposition = { systemBytes: number; summaryBytes: number; historyBytes: number };
export type LatestContext = {
  inputTokens: number | null; contextWindowTokens: number | null; modelId: string;
  stale: boolean; contextComposition?: ContextComposition | null;
};
export type RecordedUsage = {
  knownUsage: TokenTotals;
  recordedRequestCount: number;
  unknownUsageRequestCount: number;
  latestContext?: LatestContext | null;
};
export type UsageSegment = { key: string; label: string; value: number; color: string; ratio: number };

export const compactTokens = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage, {
  notation: 'compact', maximumFractionDigits: 1,
}).format(value);
export const fullTokens = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
export const usagePercent = (value: number) => String(Math.round(value * 1000) / 10) + '%';

function segments(parts: Omit<UsageSegment, 'ratio'>[]): UsageSegment[] {
  const total = parts.reduce((sum, item) => sum + item.value, 0);
  return total > 0 ? parts.filter(item => item.value > 0).map(item => ({ ...item, ratio: item.value / total })) : [];
}
export function cumulativeSegments(usage: TokenTotals): UsageSegment[] {
  return segments([
    { key: 'input', label: i18n.t("sessions:input"), value: Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens), color: 'var(--usage-input)' },
    { key: 'read', label: i18n.t("sessions:cacheRead"), value: usage.cacheReadTokens, color: 'var(--usage-cache-read)' },
    { key: 'write', label: i18n.t("sessions:cacheWrite"), value: usage.cacheWriteTokens, color: 'var(--usage-cache-write)' },
    { key: 'output', label: i18n.t("sessions:output"), value: usage.outputTokens, color: 'var(--usage-output)' },
  ]);
}
export function contextSegments(composition?: ContextComposition | null): UsageSegment[] {
  if (!composition) return [];
  return segments([
    { key: 'system', label: i18n.t("sessions:system"), value: composition.systemBytes, color: 'var(--usage-system)' },
    { key: 'summary', label: i18n.t("sessions:summary"), value: composition.summaryBytes, color: 'var(--usage-summary)' },
    { key: 'history', label: i18n.t("sessions:history"), value: composition.historyBytes, color: 'var(--usage-history)' },
  ]);
}
/** The rate applies to recorded, known usage only; unknown calls make it incomplete. */
export function cacheHitRate(usage: RecordedUsage): number | null {
  return usage.unknownUsageRequestCount === 0 && usage.knownUsage.inputTokens > 0
    ? usage.knownUsage.cacheReadTokens / usage.knownUsage.inputTokens : null;
}
export function contextRatio(context?: LatestContext | null): number | null {
  return context && context.inputTokens !== null && context.contextWindowTokens !== null && context.contextWindowTokens > 0
    ? context.inputTokens / context.contextWindowTokens : null;
}
export function contextSummary(context?: LatestContext | null): string {
  if (!context) return i18n.t("sessions:none");
  const input = context.inputTokens === null ? i18n.t("sessions:unknownUsage") : fullTokens(context.inputTokens);
  const window = context.contextWindowTokens === null ? i18n.t("sessions:unknownWindow") : compactTokens(context.contextWindowTokens);
  const ratio = contextRatio(context);
  return input + ' / ' + window + (ratio === null ? '' : ' · ' + usagePercent(ratio));
}
