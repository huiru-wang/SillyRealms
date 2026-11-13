import React,{useEffect,useMemo,useState} from 'react';
import {ChevronDown,ChevronUp,RefreshCw} from 'lucide-react';
import {api} from '../../api';

type UsageView = {
  cumulative:{
    inputTokens:number;outputTokens:number;totalTokens:number;
    cacheReadTokens:number;cacheWriteTokens:number;
    cacheHitRate:number|null;complete:boolean;unknownCount:number;
  };
  latestContext:null|{
    inputTokens:number;contextWindowTokens:number;ratio:number|null;
    modelId:string;stale:boolean;
    contextComposition?:{systemBytes:number;summaryBytes:number;historyBytes:number};
  };
};
const compact=(value:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:1}).format(value);
const full=(value:number)=>new Intl.NumberFormat('en').format(value);
const percent=(value:number)=>String(Math.round(value*1000)/10)+'%';

export function SessionTokenUsage({sessionId,refreshKey}:{sessionId:string;refreshKey:number}){
  const [usage,setUsage]=useState<UsageView|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const [expanded,setExpanded]=useState(()=>typeof window!=='undefined'&&window.matchMedia('(min-width:761px)').matches);
  const [mobile,setMobile]=useState(()=>typeof window!=='undefined'&&window.matchMedia('(max-width:760px)').matches);
  const [retry,setRetry]=useState(0);

  useEffect(()=>{
    const query=window.matchMedia('(max-width:760px)');
    const update=()=>{setMobile(query.matches);setExpanded(!query.matches);};
    query.addEventListener('change',update);
    return()=>query.removeEventListener('change',update);
  },[]);
  useEffect(()=>{setUsage(null);},[sessionId]);
  useEffect(()=>{
    const controller=new AbortController();let live=true;
    setLoading(true);setError(false);
    void api('v1/sessions/'+encodeURIComponent(sessionId)+'/usage',{signal:controller.signal,cache:'no-store'})
      .then(value=>{if(live){setUsage(value as UsageView);setError(false);}})
      .catch(()=>{if(live&&!controller.signal.aborted)setError(true);})
      .finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;controller.abort();};
  },[sessionId,refreshKey,retry]);

  const composition=usage?.latestContext?.contextComposition;
  const contextSegments=useMemo(()=>{
    if(!composition)return [];
    const total=composition.systemBytes+composition.summaryBytes+composition.historyBytes;
    if(total<=0)return [];
    return [
      {key:'system',label:'系统',value:composition.systemBytes,color:'var(--usage-system)'},
      {key:'summary',label:'摘要',value:composition.summaryBytes,color:'var(--usage-summary)'},
      {key:'history',label:'历史消息',value:composition.historyBytes,color:'var(--usage-history)'},
    ].filter(item=>item.value>0).map(item=>({...item,ratio:item.value/total}));
  },[composition]);

  const cumulative=usage?.cumulative;
  const cumulativeParts=useMemo(()=>{
    if(!cumulative)return [];
    const parts=[
      {key:'input',label:'普通输入',value:Math.max(0,cumulative.inputTokens-cumulative.cacheReadTokens-cumulative.cacheWriteTokens),color:'var(--usage-input)'},
      {key:'read',label:'缓存读取',value:cumulative.cacheReadTokens,color:'var(--usage-cache-read)'},
      {key:'write',label:'缓存写入',value:cumulative.cacheWriteTokens,color:'var(--usage-cache-write)'},
      {key:'output',label:'输出',value:cumulative.outputTokens,color:'var(--usage-output)'},
    ];
    const total=parts.reduce((sum,item)=>sum+item.value,0);
    return total>0?parts.filter(item=>item.value>0).map(item=>({...item,ratio:item.value/total})): [];
  },[cumulative]);

  const summary=loading&&!usage?'正在读取 Token 用量':usage
    ?(error?'刷新失败 · ':'')+'累计 '+full(usage.cumulative.totalTokens)+' · 上下文 '+(usage.latestContext
      ?full(usage.latestContext.inputTokens)+' / '+compact(usage.latestContext.contextWindowTokens)
      +(usage.latestContext.ratio===null?'':' · '+percent(usage.latestContext.ratio))
      :'暂无')
    :'Token 统计暂不可用';

  return <section className={'host-usage'+(mobile?' is-mobile':'')+(mobile&&expanded?' is-mobile-expanded':'')} aria-label="Token 用量统计">
    <button className="host-usage-toggle" type="button" aria-expanded={expanded} onClick={()=>mobile&&setExpanded(value=>!value)}>
      <span className="host-usage-toggle-copy">
        <span className="host-usage-toggle-title">Token 用量</span>
        <span className="host-usage-toggle-summary">{summary}</span>
      </span>
      {mobile&&<span className="host-usage-toggle-icon">{expanded?<ChevronUp size={15}/>:<ChevronDown size={15}/>}</span>}
    </button>
    {expanded&&<div className="host-usage-body">
      {error&&<div className="host-usage-error" role="status">{usage?'刷新失败，当前显示上次统计':'统计暂不可用'} <button type="button" onClick={()=>setRetry(value=>value+1)} aria-label="重试读取 Token 用量"><RefreshCw size={13}/></button></div>}
      {loading&&!usage?<div className="host-usage-loading">正在读取用量…</div>:usage&&<>
        <section className="host-usage-context" aria-label="最近上下文组成">
          <div className="host-usage-heading">
            <strong>模型上下文</strong>
            <span className="host-usage-context-total">
              {usage.latestContext?full(usage.latestContext.inputTokens)+' / '+compact(usage.latestContext.contextWindowTokens)
                +(usage.latestContext.ratio===null?'':' · '+percent(usage.latestContext.ratio)):'暂无请求记录'}
              {usage.latestContext?.stale&&<em>旧快照</em>}
            </span>
          </div>
          {usage.latestContext?.contextComposition&&contextSegments.length>0?<div className="host-usage-bar" role="img" aria-label={'上下文组成：'+contextSegments.map(item=>item.label+' '+percent(item.ratio)).join('，')}>
            {contextSegments.map(item=><span key={item.key} className={'host-usage-segment '+item.key} style={{width:(item.ratio*100)+'%',background:item.color}} title={item.label+' · '+percent(item.ratio)}>{item.ratio>=.14&&<span>{item.label}</span>}</span>)}
          </div>:<div className="host-usage-no-breakdown">{usage.latestContext?'当前上下文没有可用的结构快照':'尚无上下文快照'}</div>}
          <div className="host-usage-legend">
            <span><i className="system"/>系统</span><span><i className="summary"/>摘要</span><span><i className="history"/>历史消息</span>
          </div>
          <div className="host-usage-caption">结构占比示意，不代表模型实际 Token 分项；工具定义及动态运行信息未单独绘出。</div>
        </section>
        <section className="host-usage-cumulative" aria-label="会话累计 Token 消耗">
          <div className="host-usage-heading">
            <strong>会话累计</strong>
            <span className="host-usage-context-total"><b>{full(cumulative!.totalTokens)}</b> Tokens</span>
          </div>
          <div className="host-usage-bar cumulative" role="img" aria-label={'累计输入 '+full(cumulative!.inputTokens)+'，输出 '+full(cumulative!.outputTokens)+'，缓存读取 '+full(cumulative!.cacheReadTokens)+'，缓存写入 '+full(cumulative!.cacheWriteTokens)}>
            {cumulativeParts.map(item=><span key={item.key} className={'host-usage-segment '+item.key} style={{width:(item.ratio*100)+'%'}} title={item.label+' '+full(item.value)}/>)}
          </div>
          <div className="host-usage-legend cumulative">
            {cumulativeParts.map(item=><span key={item.key}><i className={item.key}/>{item.label} {compact(item.value)}</span>)}
          </div>
          {cumulative!.cacheHitRate!==null&&<div className="host-usage-caption">缓存读取占输入 {percent(cumulative!.cacheHitRate)}</div>}
          {!cumulative!.complete&&<div className="host-usage-caption incomplete">有 {cumulative!.unknownCount} 次模型请求未能取得用量，累计值不完整。</div>}
        </section>
      </>}
    </div>}
  </section>;
}
