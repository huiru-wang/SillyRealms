import {useEffect,useState} from 'react';
import {api,json} from '../../api';
import {Button} from '../../components/ui/Button';
import {Select} from '../../components/ui/Select';
import type {StudioPreset} from './types';
import {presetPatch} from './adapter';
/** Template is primary; this optional view resolves sources against a chosen session without running a model. */
export function PromptPreview({preset,nodeId}:{preset:StudioPreset;nodeId:string}){
 const [sessions,setSessions]=useState<Array<{id:string;title:string}>>([]),[sessionId,setSessionId]=useState('');
 const [input,setInput]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<{text:string;tokens:number}|null>(null);
 useEffect(()=>{let live=true;void (async()=>{const items:Array<{id:string;title:string}>=[];let cursor:string|null=null;do{const page:any=await api('v1/sessions?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));items.push(...page.items);cursor=page.hasMore?page.nextCursor:null;}while(cursor&&live);if(live)setSessions(items);})().catch(()=>{if(live)setError('会话列表加载失败');});return()=>{live=false;};},[]);
 async function render(){setBusy(true);setError('');setPreview(null);try{const result=await api('v1/presets/preview',{method:'POST',body:json({preset:presetPatch(preset),sessionId,input})});const row=result.preview.trace.find((r:any)=>r.nodeId===nodeId);setPreview({text:row?.messages.length?row.messages.map((m:any)=>m.role+'\n'+(typeof m.content==='string'?m.content:m.content.map((p:any)=>p.text??'').join(''))).join('\n\n'):'本轮不加入此节点。',tokens:result.estimatedInputTokens});}catch(e){setError(e instanceof Error?e.message:'预览失败');}finally{setBusy(false);}}
 return <details><summary>使用会话内容预览</summary>
  <p>查看压缩前的候选内容，不调用模型，不写入会话。</p>
  <label>会话<Select aria-label="预览会话" value={sessionId} disabled={busy} onChange={e=>{setSessionId(e.target.value);setPreview(null);}}><option value="">选择会话</option>{sessions.map(s=><option key={s.id} value={s.id}>{s.title||'未命名会话'}</option>)}</Select></label>
  <label>本轮输入<textarea aria-label="预览输入" value={input} disabled={busy} onChange={e=>{setInput(e.target.value);setPreview(null);}}/></label>
  <Button type="button" disabled={busy||!sessionId} onClick={()=>void render()}>{busy?'正在展开…':'展开节点'}</Button>
  {!sessions.length&&!error&&<p>暂无可用会话。</p>}{error&&<p role="alert">{error}</p>}
  {preview&&<><p>完整候选输入估算：{preview.tokens} tokens</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'45vh',overflow:'auto'}}>{preview.text}</pre></>}
 </details>;
}
