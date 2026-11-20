import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { api } from '../../api';
import type { Usage } from '../../../../../packages/sr-sdk/src/stage-contract';
import {
  cacheHitRate, compactTokens as compact, contextSegments, contextSummary,
  cumulativeSegments, fullTokens as full, usagePercent as percent, type RecordedUsage,
} from './usage';

export function SessionTokenUsage({ sessionId, refreshKey, latestUsage }: {
  sessionId: string; refreshKey: number; latestUsage?: Usage | null;
}) {
  const [usage, setUsage] = useState<RecordedUsage | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false), [retry, setRetry] = useState(0);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width:760px)').matches);
  const root = useRef<HTMLElement>(null), measure = useRef<HTMLSpanElement>(null);
  const [compactHeader, setCompactHeader] = useState(mobile);

  useEffect(() => {
    const query = window.matchMedia('(max-width:760px)');
    const update = () => setMobile(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
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
  const contextParts = useMemo(() => contextSegments(composition), [composition]);
  const cumulative = usage?.knownUsage;
  const cumulativeParts = useMemo(() => cumulative ? cumulativeSegments(cumulative) : [], [cumulative]);
  const hitRate = usage ? cacheHitRate(usage) : null;
  const summary = loading && !usage ? '正在读取 Token 用量' : usage
    ? (error ? '刷新失败 · ' : '') + '累计 ' + full(usage.knownUsage.totalTokens) + ' · 上下文 ' + contextSummary(usage.latestContext)
    : 'Token 统计暂不可用';

  useLayoutEffect(() => {
    const element = root.current, probe = measure.current;
    const toolbar = element?.closest<HTMLElement>('[data-session-toolbar]'), actions = element?.parentElement;
    if (!element || !probe || !toolbar || !actions) return;
    // Measure the complete label separately so a compact header never feeds back into its own width.
    const update = () => {
      const style = getComputedStyle(toolbar), actionStyle = getComputedStyle(actions);
      const otherActions = Array.from(actions.children).filter(child => child !== element);
      const otherWidth = otherActions.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
      const available = toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        - Math.min(180, toolbar.clientWidth * .25) - (parseFloat(style.columnGap) || 0)
        - otherWidth - (parseFloat(actionStyle.columnGap) || 0) * otherActions.length;
      setCompactHeader(mobile || probe.getBoundingClientRect().width + 2 > available);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(toolbar); observer.observe(probe);
    for (const child of actions.children) if (child !== element) observer.observe(child);
    return () => observer.disconnect();
  }, [summary, mobile]);

  return <section ref={root} className={'host-usage' + (compactHeader ? ' is-compact' : '') + (mobile ? ' is-mobile' : '') + (mobile && expanded ? ' is-mobile-expanded' : '')} aria-label="Token 用量统计">
    <button className="host-usage-toggle" type="button" aria-expanded={expanded} aria-label={'用量：' + summary} title={summary} onClick={() => setExpanded(value => !value)}>
      <span className="host-usage-toggle-copy"><span className="host-usage-toggle-title">用量</span><span className="host-usage-toggle-summary" hidden={compactHeader}>{summary}</span></span>
      {compactHeader && <span className="host-usage-toggle-icon">{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span>}
    </button>
    <span className="host-usage-measure-box" aria-hidden="true"><span ref={measure} className="host-usage-measure host-usage-toggle-copy"><span>用量</span><span>{summary}</span></span></span>
    {expanded && <div className="host-usage-content">
      {error && <div className="host-usage-error" role="status">{usage ? '刷新失败，当前显示上次统计' : '统计暂不可用'} <button type="button" onClick={() => setRetry(value => value + 1)} aria-label="重试读取 Token 用量"><RefreshCw size={13} /></button></div>}
      {loading && !usage ? <div className="host-usage-loading" role="status">正在读取用量…</div> : usage && <>
        <section className="host-usage-context" aria-label="最近上下文组成">
          <div className="host-usage-heading">
            <strong>模型上下文</strong>
            <span className="host-usage-context-total">
              {usage.latestContext ? contextSummary(usage.latestContext) : '暂无请求快照'}
              {usage.latestContext?.stale && <em>旧快照</em>}
            </span>
          </div>
          {contextParts.length > 0 ? <>
            <div className="host-usage-bar" role="img" aria-label={'上下文组成（编译字节）：' + contextParts.map(item => item.label + ' ' + percent(item.ratio)).join('，')}>
              {contextParts.map(item => <span key={item.key} className={'host-usage-segment ' + item.key} style={{ width: (item.ratio * 100) + '%', background: item.color }} title={item.label + ' · ' + percent(item.ratio)}>{item.ratio >= .14 && <span>{item.label}</span>}</span>)}
            </div>
            <p className="host-usage-caption">组成按编译上下文字节占比展示（含约定消息开销），不代表各类实际计费 Token。</p>
          </> : <div className="host-usage-no-breakdown">{usage.latestContext === undefined
            ? '服务端未提供上下文快照' : usage.latestContext ? '这次请求未记录上下文组成' : '尚无上下文快照'}</div>}
          <div className="host-usage-legend">
            <span><i className="system" />系统</span><span><i className="summary" />摘要</span><span><i className="history" />历史消息</span>
          </div>
        </section>
        <section className="host-usage-cumulative" aria-label="会话累计 Token 消耗">
          <div className="host-usage-heading"><strong>会话累计</strong><span className="host-usage-context-total"><b>{full(cumulative!.totalTokens)}</b> Tokens</span></div>
          <div className="host-usage-bar cumulative" role="img" aria-label={'累计输入 ' + full(cumulative!.inputTokens) + '，输出 ' + full(cumulative!.outputTokens) + '，缓存读取 ' + full(cumulative!.cacheReadTokens) + '，缓存写入 ' + full(cumulative!.cacheWriteTokens)}>
            {cumulativeParts.map(item => <span key={item.key} className={'host-usage-segment ' + item.key} style={{ width: (item.ratio * 100) + '%', background: item.color }} title={item.label + ' ' + full(item.value)} />)}
          </div>
          <div className="host-usage-legend cumulative">
            {cumulativeParts.map(item => <span key={item.key}><i className={item.key} />{item.label} {compact(item.value)}</span>)}
            {hitRate !== null && <span className="host-usage-cache-hit">缓存命中：{percent(hitRate)}</span>}
          </div>
          {usage.unknownUsageRequestCount > 0 && <div className="host-usage-caption incomplete">有 {usage.unknownUsageRequestCount} 次已记录模型请求未取得用量，累计值不完整。</div>}
          <p className="host-usage-caption">统计基于 {usage.recordedRequestCount} 次已保存调用，未保存的调用可能未计入。</p>
        </section>
      </>}
      {latestUsage !== undefined && <p className="host-usage-caption">最近一轮：{latestUsage === null ? '模型未返回完整用量' : full(latestUsage.total_tokens) + ' Tokens'}。本轮用量不重复加入累计。</p>}
    </div>}
  </section>;
}
