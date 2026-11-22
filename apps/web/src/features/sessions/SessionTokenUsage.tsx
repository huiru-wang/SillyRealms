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
  const contextParts = useMemo(() => contextSegments(composition), [composition]);
  const cumulative = usage?.knownUsage;
  const cumulativeParts = useMemo(() => cumulative ? cumulativeSegments(cumulative) : [], [cumulative]);
  const hitRate = usage ? cacheHitRate(usage) : null;

  return <section className="host-usage" aria-label="Token 用量统计">
    <button ref={trigger} className="host-usage-toggle" type="button" aria-expanded={expanded} aria-controls={expanded?panelId:undefined} onClick={() => setExpanded(value => !value)}>
      用量{expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
    </button>
    {expanded && <SessionUsagePopover id={panelId} anchor={trigger} onClose={()=>setExpanded(false)}>
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
        </section>
      </>}
    </SessionUsagePopover>}
  </section>;
}
