import {useEffect,useState} from 'react';
import {ChevronDown,ChevronUp,RefreshCw} from 'lucide-react';
import {api} from '../../api';
import type {Usage} from '../../../../../packages/sr-sdk/src/stage-contract';

type RecordedUsage = {
  knownUsage:{inputTokens:number;outputTokens:number;totalTokens:number;cacheReadTokens:number;cacheWriteTokens:number};
  recordedRequestCount:number;unknownUsageRequestCount:number;
};
const full=(value:number)=>new Intl.NumberFormat('en').format(value);
/** Only quantities returned by ServerV2 are shown; recorded usage is not a complete bill. */
export function SessionTokenUsage({sessionId,refreshKey,latestUsage}:{sessionId:string;refreshKey:number;latestUsage?:Usage|null}){
  const [usage,setUsage]=useState<RecordedUsage|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [expanded,setExpanded]=useState(false),[reload,setReload]=useState(0);
  useEffect(()=>{setUsage(null);},[sessionId]);
  useEffect(()=>{
    const abort=new AbortController();setLoading(true);setError('');
    void api<RecordedUsage>('v1/sessions/'+encodeURIComponent(sessionId)+'/narrative/usage',{signal:abort.signal,cache:'no-store'})
      .then(value=>{if(!abort.signal.aborted)setUsage(value);})
      .catch(reason=>{if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'用量读取失败');})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[sessionId,refreshKey,reload]);
  const known=usage?.knownUsage;
  const parts=known?[
    {label:'输入（不含缓存）',value:Math.max(0,known.inputTokens-known.cacheReadTokens-known.cacheWriteTokens),color:'var(--usage-input)'},
    {label:'缓存读取',value:known.cacheReadTokens,color:'var(--usage-cache-read)'},
    {label:'缓存写入',value:known.cacheWriteTokens,color:'var(--usage-cache-write)'},
    {label:'输出',value:known.outputTokens,color:'var(--usage-output)'},
  ]:[];
  const total=parts.reduce((sum,item)=>sum+item.value,0);
  return <section className="host-usage" aria-label="Token 用量统计">
    <button className="host-usage-toggle" type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)} title={known?'已记录 '+full(known.totalTokens)+' Tokens':'Token 用量'}>
      <span>用量</span>{expanded?<ChevronUp size={15}/>:<ChevronDown size={15}/>}</button>
    {expanded&&<div className="host-usage-content">
      {error&&<p role="alert">{error} <button type="button" aria-label="重新读取用量" onClick={()=>setReload(value=>value+1)}><RefreshCw size={14}/></button></p>}
      {loading&&!usage?<p role="status">正在读取用量…</p>:known&&<>
        <div className="host-usage-heading"><strong>已记录用量</strong><span>{full(known.totalTokens)} Tokens</span></div>
        {!!total&&<div className="host-usage-bar" role="img" aria-label={parts.map(part=>part.label+' '+full(part.value)).join('，')}>
          {parts.filter(part=>part.value>0).map(part=><span key={part.label} className="host-usage-segment" style={{width:(part.value/total*100)+'%',background:part.color}} title={part.label+' '+full(part.value)}/>)}</div>}
        <dl className="usage-values"><div><dt>输入</dt><dd>{full(known.inputTokens)}</dd></div><div><dt>输出</dt><dd>{full(known.outputTokens)}</dd></div><div><dt>缓存读取</dt><dd>{full(known.cacheReadTokens)}</dd></div><div><dt>缓存写入</dt><dd>{full(known.cacheWriteTokens)}</dd></div></dl>
        <p className="host-usage-caption">已保存 {usage!.recordedRequestCount} 次调用记录{usage!.unknownUsageRequestCount?'，其中 '+usage!.unknownUsageRequestCount+' 次用量未知，未计入合计':''}。</p>
      </>}
      {latestUsage!==undefined&&<p className="host-usage-caption">最近一轮：{latestUsage===null?'模型未返回完整用量':full(latestUsage.total_tokens)+' Tokens'}。本轮实时用量不重复加入历史合计。</p>}
      <p className="host-usage-caption">统计来自已保存的调用记录，可能不包含未能保存的调用。</p>
    </div>}
  </section>;
}
