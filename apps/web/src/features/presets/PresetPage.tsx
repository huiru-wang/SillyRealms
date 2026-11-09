import React,{useEffect,useRef,useState} from 'react';
import {Link,useNavigate,useParams} from 'react-router-dom';
import {ArrowDown,ArrowLeft,ArrowUp,Check,ChevronDown,ChevronRight,Download,Plus,Save,Trash2} from 'lucide-react';
import {api,json} from '../../api';
import {randomId} from '../../random-id';
import {ErrorNotice,Header,Loading,useLoad} from '../../app/ui';

const BUILTIN=['main','personaInfo','characterInfo','worldState','chatHistory','userInput','postHistory'];
function blankPreset(){
 return {name:'',description:'',model_parameters:{temperature:1},budget:{context_strategy:'standard',max_output_tokens:2048},summary_prompt:'总结此前发生的故事。',nodes:BUILTIN.map(id=>({
  id,kind:'system',name:({main:'叙事风格',personaInfo:'玩家设定',characterInfo:'角色设定',worldState:'世界状态',chatHistory:'聊天历史',userInput:'玩家输入',postHistory:'历史后置'} as Record<string,string>)[id],
  source:id,role:id==='chatHistory'?'auto':id==='userInput'?'user':'system',enabled:true,...(id==='main'?{content:''}:{})
 }))};
}
/** Primary: save coherent prompt configuration. No model association. */
export function PresetPage({isNew=false}:{isNew?:boolean}){
 const {id}=useParams();const navigate=useNavigate();
 const source=useLoad(isNew?null:'v1/presets/'+id);
 const defaults=useLoad('v1/app-settings');
 const [draft,setDraft]=useState<any>(()=>isNew?blankPreset():null);
 const [saving,setSaving]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState('');
 const [expanded,setExpanded]=useState<Record<string,boolean>>({});
 const saveRef=useRef(false);
 useEffect(()=>{if(source.value){
   setDraft({...source.value.item,nodes:source.value.item.nodes.map((n:any)=>n.id==='postHistory'?n:{...n,enabled:true})});
 }},[source.value]);
 if(!draft)return <main className="page narrow">{source.error?<ErrorNotice message={source.error} onRetry={source.reload}/>:<Loading text="正在读取预设…"/>}</main>;
 const nodes:any[]=draft.nodes;
 const update=(patch:any)=>{setDraft((prev:any)=>({...prev,...patch}));setSaved('');};
 const updateNode=(index:number,patch:any)=>update({nodes:nodes.map((n,i)=>index===i?{...n,...patch}:n)});
 const move=(index:number,to:number)=>{
  if(to<0||to>=nodes.length)return;
  const next=[...nodes];[next[index],next[to]]=[next[to],next[index]];update({nodes:next});
 };
 const remove=(index:number)=>update({nodes:nodes.filter((_,i)=>i!==index)});
 const add=()=>{const uid=randomId();update({nodes:[...nodes,{id:uid,kind:'text',name:'新文本节点',role:'system',enabled:true,content:''}]});setExpanded(v=>({...v,[uid]:true}));};
 const save=async()=>{
  if(saveRef.current)return;
  setError('');setSaved('');
  if(!draft.name?.trim()){setError('请输入预设名称。');return;}
  if(!nodes.some(n=>n.id==='worldState'&&n.enabled)){setError('世界状态节点必须启用。');return;}
  saveRef.current=true;setSaving(true);
  try{
   if(isNew){const result=await api('v1/presets',{method:'POST',body:json(draft)});navigate('/presets/'+result.item.id,{replace:true});}
   else{
     const originals:any[]=source.value.item.nodes;
     const patch={
      name:draft.name,description:draft.description??null,model_parameters:draft.model_parameters??{},
      budget:draft.budget,summary_prompt:draft.summary_prompt,
      nodes:nodes.filter(n=>originals.some(o=>o.id===n.id)).map(n=>({id:n.id,name:n.name,enabled:n.enabled,role:n.role,...(n.content!==undefined?{content:n.content}:{})})),
      add_nodes:nodes.filter(n=>!originals.some(o=>o.id===n.id)),
      remove_node_ids:originals.filter(o=>!nodes.some(n=>n.id===o.id)).map(o=>o.id),
      nodes_order:nodes.map(n=>n.id),
     };
     await api('v1/presets/'+id,{method:'PATCH',body:json(patch)});
     await source.reload();setSaved('已保存，后续调用将使用更新后的预设。');
   }
  }catch(e){setError(e instanceof Error?e.message:String(e));}
  finally{saveRef.current=false;setSaving(false);}
 };
 const destroy=async()=>{
  if(!confirm('删除此预设？被应用、世界或会话引用的预设不能删除。'))return;
  setError('');
  try{await api('v1/presets/'+id,{method:'DELETE'});navigate('/presets');}
  catch(e){setError(e instanceof Error?e.message:String(e));}
 };
 const isDefault=defaults.value?.item?.defaultPresetId===id;
 return <main className="page narrow preset-editor-page">
   <Link to="/presets" className="editor-back"><ArrowLeft size={15}/> 返回预设列表</Link>
   <Header eyebrow="PRESET EDITOR" title={isNew?'新建预设':'编辑预设'} description="专注提示词与生成策略。模型连接独立配置，世界和会话按需关联。">
    {!isNew&&<><a className="button secondary" href={'/api/v1/presets/'+id+'/export'} download={draft.name+'.json'}><Download size={16}/> 导出</a><button className="button tertiary danger" onClick={()=>void destroy()}><Trash2 size={16}/> 删除</button></>}
    <button className="button primary" disabled={saving} onClick={()=>void save()}><Save size={16}/>{saving?'保存中…':isNew?'创建预设':'保存更改'}</button>
   </Header>
   {isDefault&&<div className="preset-editor-default"><Check size={16}/> 当前应用默认预设。修改共享内容会影响引用此预设的会话在后续生成中的行为。</div>}
   {error&&<ErrorNotice message={error}/>}
   {saved&&<div className="preset-save-ok" role="status"><Check size={16}/>{saved}</div>}
   <div className="preset-editor-layout">
    <section className="preset-editor-main">
      <section className="editor-section">
        <div className="editor-section-head"><div><h2>基本信息</h2><p>给这个叙事预设一个清晰的名字和用途说明。</p></div><span className="editor-section-index">01</span></div>
        <div className="editor-form">
          <label>预设名称 <input value={draft.name} onChange={e=>update({name:e.target.value})} placeholder="例如：通用叙事"/></label>
          <label>简介 <textarea rows={2} value={draft.description??''} onChange={e=>update({description:e.target.value})} placeholder="这个预设适合什么样的故事？"/></label>
        </div>
      </section>
      <section className="editor-section">
        <div className="editor-section-head"><div><h2>生成策略</h2><p>控制输出预算与摘要行为，不绑定特定模型。</p></div><span className="editor-section-index">02</span></div>
        <div className="editor-form editor-form-cols">
          <label>最大输出 Token<input type="number" min="1" value={draft.budget.max_output_tokens} onChange={e=>update({budget:{...draft.budget,max_output_tokens:Number(e.target.value)}})}/></label>
          <label>温度（0–2）<input type="number" min="0" max="2" step="0.1" value={draft.model_parameters?.temperature??1} onChange={e=>update({model_parameters:{...draft.model_parameters,temperature:Number(e.target.value)}})}/></label>
          <label>上下文策略<select value={draft.budget.context_strategy} onChange={e=>update({budget:{...draft.budget,context_strategy:e.target.value}})}><option value="compact">轻量对话 · 128K</option><option value="standard">标准叙事 · 256K</option><option value="extended">长篇沉浸 · 512K</option></select><small>实际容量受会话所选模型的上下文窗口限制。</small></label>
          <label className="editor-wide">摘要 Prompt<textarea rows={3} value={draft.summary_prompt??''} onChange={e=>update({summary_prompt:e.target.value})}/></label>
        </div>
      </section>
      <section className="editor-section">
        <div className="editor-section-head"><div><h2>提示词编排</h2><p>按从上至下的顺序构建上下文，点击节点展开编辑。</p></div><button className="button secondary" onClick={add}><Plus size={15}/> 新增文本节点</button></div>
        <p className="editor-node-help">平台内置的角色扮演协议始终置于最前，不属于此预设；下方的「叙事风格」节点可配置自定义写作风格，留空则不增加额外提示词。</p>
        <div className="editor-nodes">{nodes.map((n,index)=>{
         const open=!!expanded[n.id];const editable=n.kind==='text';const canEditPrompt=editable||n.id==='main'||n.id==='postHistory';
         return <div className={'editor-node '+(open?'open':'')} key={n.id}>
           <div className="editor-node-bar">
             <button type="button" className="editor-node-expand" aria-expanded={open} onClick={()=>setExpanded(v=>({...v,[n.id]:!open}))}><span className="editor-node-number">{String(index+1).padStart(2,'0')}</span><span className="editor-node-name">{n.name}</span><span className="editor-node-kind">{editable?'自定义':n.source}</span>{open?<ChevronDown size={16}/>:<ChevronRight size={16}/>}</button>
             <div className="editor-node-actions"><button className="icon-button" aria-label="上移节点" title="上移" disabled={index===0} onClick={()=>move(index,index-1)}><ArrowUp size={15}/></button><button className="icon-button" aria-label="下移节点" title="下移" disabled={index===nodes.length-1} onClick={()=>move(index,index+1)}><ArrowDown size={15}/></button>{editable&&<button className="icon-button" aria-label="删除节点" onClick={()=>remove(index)}><Trash2 size={15}/></button>}</div>
           </div>
           {open&&<div className="editor-node-content">
             <div className="editor-form editor-form-cols"><label>节点名称<input value={n.name} onChange={e=>updateNode(index,{name:e.target.value})}/></label><label>消息角色<select value={n.role} disabled={!editable} onChange={e=>updateNode(index,{role:e.target.value})}><option value="system">system</option><option value="user">user</option><option value="assistant">assistant</option>{n.role==='auto'&&<option value="auto">auto</option>}</select></label>
               {canEditPrompt&&<label className="editor-wide">Prompt 内容<textarea rows={6} value={n.content??''} onChange={e=>updateNode(index,{content:e.target.value})}/></label>}
             </div>
             {n.id==='postHistory'&&<label className="editor-node-enable"><input type="checkbox" checked={n.enabled} onChange={e=>updateNode(index,{enabled:e.target.checked})}/> 启用后置节点</label>}
             {!canEditPrompt&&<p className="editor-node-help">内置节点由运行时提供，必须启用。节点位置可调整。</p>}
           </div>}
         </div>;
        })}</div>
      </section>
    </section>
   </div>
 </main>;
}
