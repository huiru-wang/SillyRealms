import React,{useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {ArrowRight,FileText,Plus,Upload,SlidersHorizontal,Check} from 'lucide-react';
import {api,json} from '../../api';
import {Empty,ErrorNotice,Header,Loading,SearchInput,useLoad,usePaged} from '../../app/ui';

export function PresetLibraryPage(){
 const navigate=useNavigate();
 const [query,setQuery]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const list=usePaged('v1/presets?limit=100'),settings=useLoad('v1/app-settings');
 const items=(list.value?.items??[]).filter((p:any)=>[p.name,p.description].some(x=>String(x??'').toLowerCase().includes(query.trim().toLowerCase())));
 const importPreset=async(file:File)=>{
   setError('');setBusy(true);
   try {const result=await api('v1/presets/import',{method:'POST',body:await file.text()});navigate('/presets/'+result.item.id);}
   catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 };
 const makeDefault=async(id:string)=>{
   setError('');try{await api('v1/app-settings',{method:'PATCH',body:json({defaultPresetId:id})});await settings.reload();}
   catch(e){setError(e instanceof Error?e.message:String(e));}
 };
 return <main className="page preset-library-page">
   <Header eyebrow="PROMPT LIBRARY" title="预设" description="管理提示词、叙事规则和上下文策略。预设与模型连接独立。">
     <label className="button secondary upload-button"><Upload size={16}/>{busy?'导入中…':'导入'}<input type="file" disabled={busy} accept=".json,application/json" onChange={e=>{const f=e.target.files?.[0];if(f)void importPreset(f);e.target.value='';}}/></label>
     <Link className="button primary" to="/presets/new"><Plus size={16}/> 新建预设</Link>
   </Header>
   {error&&<ErrorNotice message={error}/>}
   {list.error&&<ErrorNotice message={list.error} onRetry={list.reload}/>}
   {!list.value&&list.loading?<Loading text="正在加载预设…"/>:!list.value?.items?.length?<Empty text="还没有预设。导入或创建你的第一个预设。" action="新建预设" to="/presets/new"/>:<>
     <div className="library-controls"><div><h2>全部预设 <span>{items.length}</span></h2><p>一个预设可被多个世界和会话引用。</p></div><SearchInput value={query} onChange={setQuery} placeholder="搜索预设…"/></div>
     <div className="preset-collection">{items.length?items.map((p:any)=><article className="preset-item" key={p.id}>
       <Link className="preset-item-main" to={'/presets/'+p.id}><div className="preset-glyph"><SlidersHorizontal size={19}/></div><div><h3>{p.name}</h3><p>{p.description||'自定义 Prompt 与叙事策略'}</p></div><ArrowRight size={16}/></Link>
       {settings.value?.item?.defaultPresetId===p.id?<span className="state-chip positive"><Check size={13}/> 默认预设</span>:<button className="button tertiary" onClick={()=>void makeDefault(p.id)}>设为默认</button>}
     </article>):<Empty text="没有找到匹配的预设"/>}</div>
     {list.value?.hasMore&&<button className="button secondary load-more" disabled={list.loading} onClick={list.more}>加载更多</button>}
   </>}
 </main>;
}
