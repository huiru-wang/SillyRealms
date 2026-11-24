import {useTranslation} from 'react-i18next';
import {i18n} from '../../i18n/instance.ts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { api } from '../../api';
import {SessionUsagePopover} from './SessionUsagePopover';
import {
  cacheHitRate, compactTokens as compact, contextSegments, contextSummary,
  cumulativeSegments, fullTokens as full, usagePercent as percent, type RecordedUsage,
} from './usage';

export function SessionTokenUsage({ sessionId, refreshKey }: {
  sessionId: string; refreshKey: number;
}) {
  useTranslation();
  const [usage, setUsage] = useState<RecordedUsage | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false), [retry, setRetry] = useState(0);
  const trigger=useRef<HTMLButtonElement>(null),panelId=useId();
  useEffect(() => { setUsage(null); setExpanded(false); }, [sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false);
    void api<RecordedUsage>('v1/sessions/' + encodeURIComponent(sessionId) + '/narrative/usage', {
      signal: controller.signal, cache: 'no-store',
    }).then(value => {
      if (!controller.signal.aborted) { setUsage(value); setError(false); }
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [sessionId, refreshKey, retry]);

  const composition = usage?.latestContext?.contextComposition;
  const contextParts = useMemo(() => contextSegments(composition), [composition,i18n.resolvedLanguage]);
  const cumulative = usage?.knownUsage;
  const cumulativeParts = useMemo(() => cumulative ? cumulativeSegments(cumulative) : [], [cumulative,i18n.resolvedLanguage]);
  const hitRate = usage ? cacheHitRate(usage) : null;

  return <section className="host-usage" aria-label={i18n.t("sessions:tokenUsage")}>
    <button ref={trigger} className="host-usage-toggle" type="button" aria-expanded={expanded} aria-controls={expanded?panelId:undefined} onClick={() => setExpanded(value => !value)}>
      {i18n.t("sessions:usage")}{expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
    </button>
    {expanded && <SessionUsagePopover id={panelId} anchor={trigger} onClose={()=>setExpanded(false)}>
      {error && <div className="host-usage-error" role="status">{usage ? i18n.t("sessions:usageRefreshFailed") : i18n.t("sessions:usageUnavailable")} <button type="button" onClick={() => setRetry(value => value + 1)} aria-label={i18n.t("sessions:retryUsage")}><RefreshCw size={13} /></button></div>}
      {loading && !usage ? <div className="host-usage-loading" role="status">{i18n.t("sessions:loadingUsage")}</div> : usage && <>
        <section className="host-usage-context" aria-label={i18n.t("sessions:recentContext")}>
          <div className="host-usage-heading">
            <strong>{i18n.t("sessions:modelContext")}</strong>
            <span className="host-usage-context-total">
              {usage.latestContext ? contextSummary(usage.latestContext) : i18n.t("sessions:noRequestSnapshot")}
              {usage.latestContext?.stale && <em>{i18n.t("sessions:staleSnapshot")}</em>}
            </span>
          </div>
          {contextParts.length > 0 ? <>
            <div className="host-usage-bar" role="img" aria-label={i18n.t("sessions:contextBreakdown") + contextParts.map(item => item.label + ' ' + percent(item.ratio)).join(' · ')}>
              {contextParts.map(item => <span key={item.key} className={'host-usage-segment ' + item.key} style={{ width: (item.ratio * 100) + '%', background: item.color }} title={item.label + ' · ' + percent(item.ratio)}>{item.ratio >= .14 && <span>{item.label}</span>}</span>)}
            </div>
            <p className="host-usage-caption">{i18n.t("sessions:contextBytesHint")}</p>
          </> : <div className="host-usage-no-breakdown">{usage.latestContext === undefined
            ? i18n.t("sessions:contextNotProvided") : usage.latestContext ? i18n.t("sessions:contextNotRecorded") : i18n.t("sessions:noContext")}</div>}
          <div className="host-usage-legend">
            <span><i className="system" />{i18n.t("sessions:system")}</span><span><i className="summary" />{i18n.t("sessions:summary")}</span><span><i className="history" />{i18n.t("sessions:history")}</span>
          </div>
        </section>
        <section className="host-usage-cumulative" aria-label={i18n.t("sessions:totalTokenUsage")}>
          <div className="host-usage-heading"><strong>{i18n.t("sessions:sessionTotal")}</strong><span className="host-usage-context-total"><b>{full(cumulative!.totalTokens)}</b> Tokens</span></div>
          <div className="host-usage-bar cumulative" role="img" aria-label={i18n.t("sessions:cumulativeDescription",{input:full(cumulative!.inputTokens),output:full(cumulative!.outputTokens),read:full(cumulative!.cacheReadTokens),write:full(cumulative!.cacheWriteTokens)})}>
            {cumulativeParts.map(item => <span key={item.key} className={'host-usage-segment ' + item.key} style={{ width: (item.ratio * 100) + '%', background: item.color }} title={item.label + ' ' + full(item.value)} />)}
          </div>
          <div className="host-usage-legend cumulative">
            {cumulativeParts.map(item => <span key={item.key}><i className={item.key} />{item.label} {compact(item.value)}</span>)}
            {hitRate !== null && <span className="host-usage-cache-hit">{i18n.t("sessions:cacheHit")}{percent(hitRate)}</span>}
          </div>
          {usage.unknownUsageRequestCount > 0 && <div className="host-usage-caption incomplete">{i18n.t("sessions:unknownRequests",{count:usage.unknownUsageRequestCount})}</div>}
        </section>
      </>}
    </SessionUsagePopover>}
  </section>;
}
