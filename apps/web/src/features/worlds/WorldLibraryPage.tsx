import React,{useEffect,useRef,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {BookOpen,CheckSquare2,FolderOpen,GripVertical,Plus,SlidersHorizontal,Square,Upload} from 'lucide-react';
import {api,json} from '../../api';
import {Empty,ErrorNotice,Header,Loading,SearchInput,useLoad,usePaged} from '../../app/ui';

type Tag={id:string;name:string;sort_order?:number};
type MatchMode='all'|'any';

/** World catalog filtering and ordering are server-backed, including cursor pagination. */
export function WorldLibraryPage(){
  const navigate=useNavigate();
  const [search,setSearch]=useState(''),[appliedSearch,setAppliedSearch]=useState('');
  const [selectedIds,setSelectedIds]=useState<string[]>([]);
  const [matchMode,setMatchMode]=useState<MatchMode>('all');
  const [orderedTags,setOrderedTags]=useState<Tag[]>([]);
  const [draggingId,setDraggingId]=useState<string|null>(null);
  const [sorting,setSorting]=useState(false),[sortError,setSortError]=useState('');
  const [mobileFiltersOpen,setMobileFiltersOpen]=useState(false);
  const [importing,setImporting]=useState(false),[importError,setImportError]=useState('');
  const drag=useRef<{id:string;initialIds:string[];currentIds:string[]}|null>(null);
  const tags=useLoad('v1/tags?type=world');

  useEffect(()=>{const timer=setTimeout(()=>setAppliedSearch(search.trim()),250);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{if(tags.value?.items)setOrderedTags(tags.value.items);},[tags.value]);
  useEffect(()=>{if(!tags.value?.items)return;const valid=new Set((tags.value.items as Tag[]).map(t=>t.id));setSelectedIds(previous=>previous.filter(id=>valid.has(id)));},[tags.value]);
  const params=new URLSearchParams({limit:'24'});
  for(const id of selectedIds)params.append('tagId',id);
  if(selectedIds.length)params.set('match',matchMode);
  if(appliedSearch)params.set('query',appliedSearch);
  const list=usePaged('v1/worlds?'+params.toString());
  const items:any[]=list.value?.items??[];
  const filtered=selectedIds.length>0||!!appliedSearch;
  const hasTags=orderedTags.length>0;
  const clearFilters=()=>{setSelectedIds([]);setSearch('');setAppliedSearch('');setMatchMode('all');};

  const saveOrder=async(currentIds:string[],previousIds:string[])=>{
    if(currentIds.join('|')===previousIds.join('|'))return;
    setSorting(true);setSortError('');
    try{
      await api('v1/tags/order',{method:'PUT',body:json({type:'world',orderedIds:currentIds})});
      await tags.reload();
    }catch(error){
      const byId=new Map(orderedTags.map(tag=>[tag.id,tag]));
      setOrderedTags(previousIds.map(id=>byId.get(id)).filter((tag):tag is Tag=>!!tag));
      setSortError(error instanceof Error?error.message:'标签排序保存失败');
    }finally{setSorting(false);}
  };
  const reorder=(id:string,targetId:string)=>{
    if(!drag.current||id===targetId)return;
    const next=[...drag.current.currentIds];
    const from=next.indexOf(id),to=next.indexOf(targetId);
    if(from<0||to<0)return;
    next.splice(from,1);next.splice(to,0,id);
    drag.current.currentIds=next;
    const byId=new Map(orderedTags.map(tag=>[tag.id,tag]));
    setOrderedTags(next.map(tagId=>byId.get(tagId)).filter((tag):tag is Tag=>!!tag));
  };
  const startDrag=(event:React.PointerEvent<HTMLButtonElement>,id:string)=>{
    if(sorting||(event.pointerType==='mouse'&&event.button!==0))return;
    const ids=orderedTags.map(tag=>tag.id);
    drag.current={id,initialIds:ids,currentIds:ids};
    setDraggingId(id);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag=(event:React.PointerEvent<HTMLButtonElement>)=>{
    if(!drag.current)return;
    const target=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-world-tag-id]');
    const targetId=target?.dataset.worldTagId;
    if(targetId)reorder(drag.current.id,targetId);
  };
  const endDrag=()=>{
    const current=drag.current;drag.current=null;setDraggingId(null);
    if(current)void saveOrder(current.currentIds,current.initialIds);
  };
  const cancelDrag=()=>{
    const current=drag.current;drag.current=null;setDraggingId(null);
    if(!current)return;
    const byId=new Map(orderedTags.map(tag=>[tag.id,tag]));
    setOrderedTags(current.initialIds.map(id=>byId.get(id)).filter((tag):tag is Tag=>!!tag));
  };
  const moveWithKeyboard=(event:React.KeyboardEvent<HTMLButtonElement>,id:string)=>{
    if(sorting||!['ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();
    const previous=orderedTags.map(tag=>tag.id);
    const from=previous.indexOf(id),to=from+(event.key==='ArrowUp'?-1:1);
    if(to<0||to>=previous.length)return;
    const current=[...previous];current.splice(from,1);current.splice(to,0,id);
    const byId=new Map(orderedTags.map(tag=>[tag.id,tag]));
    setOrderedTags(current.map(tagId=>byId.get(tagId)!).filter(Boolean));
    void saveOrder(current,previous);
  };
  const toggleTag=(id:string)=>setSelectedIds(previous=>previous.includes(id)?previous.filter(k=>k!==id):[...previous,id]);

  const importWorld=async(file:File)=>{
    setImporting(true);setImportError('');
    try{
      const body=new FormData();body.append('file',file);
      const result=await api('v1/worlds/import',{method:'POST',body});
      navigate('/worlds/'+result.item.id+'?start=1');
    }catch(error){setImportError(error instanceof Error?error.message:String(error));}
    finally{setImporting(false);}
  };
  return <main className="page library-page">
    <Header eyebrow="YOUR WORLDS" title="世界库" description="一个世界，无数种故事。从这里开始你的下一段旅程。"><label className={'button primary upload-button'+(importing?' is-busy':'')}><Upload size={16}/>{importing?'导入中…':'导入世界卡'}<input type="file" accept=".json,application/json" disabled={importing} onChange={event=>{const file=event.target.files?.[0];if(file)void importWorld(file);event.target.value='';}}/></label></Header>
    {importError&&<ErrorNotice message={'导入失败：'+importError}/>}
    {sortError&&<ErrorNotice message={'标签顺序未保存：'+sortError} onRetry={()=>void tags.reload()}/>}
    {list.error&&<ErrorNotice message={list.error} onRetry={list.reload}/>}
    {!list.value&&list.loading?<Loading text="正在整理世界库…"/>:
      (!items.length&&!filtered&&!list.loading)?<div className="world-empty"><div className="empty-illustration"><BookOpen size={35} strokeWidth={1.3}/></div><span className="eyebrow">START YOUR JOURNEY</span><h2>故事，从一个世界开始</h2><p>导入一个世界卡，SR 会自动使用你预设好的运行配置。</p><label className="button primary upload-button"><Plus size={17}/> 导入第一张世界卡<input type="file" accept=".json,application/json" disabled={importing} onChange={event=>{const file=event.target.files?.[0];if(file)void importWorld(file);event.target.value='';}}/></label></div>:
      <div className={'library-layout'+(hasTags?' has-filters':'')}>
        {hasTags&&<><button type="button" className="mobile-filter-toggle button secondary" aria-expanded={mobileFiltersOpen} onClick={()=>setMobileFiltersOpen(open=>!open)}><SlidersHorizontal size={16}/> 标签筛选 {selectedIds.length>0&&<span>{selectedIds.length}</span>}</button>
          <aside className={'filter-sidebar'+(mobileFiltersOpen?' mobile-open':'')} aria-label="世界标签筛选">
            <div className="filter-sidebar-heading"><h2>标签</h2>{sorting&&<small>保存顺序中…</small>}</div>
            <button className={'filter-all'+(!selectedIds.length?' active':'')} type="button" onClick={()=>setSelectedIds([])}><FolderOpen size={16}/> 全部世界</button>
            <div className="filter-match-label">匹配方式</div>
            <div className="filter-match-control" role="group" aria-label="标签匹配方式">
              <button type="button" aria-pressed={matchMode==='all'} className={matchMode==='all'?'active':''} onClick={()=>setMatchMode('all')}>全部匹配</button>
              <button type="button" aria-pressed={matchMode==='any'} className={matchMode==='any'?'active':''} onClick={()=>setMatchMode('any')}>部分匹配</button>
            </div>
            <div className="filter-tag-stack">
              {orderedTags.map(tag=><div key={tag.id} className={'filter-tag-row'+(selectedIds.includes(tag.id)?' active':'')+(draggingId===tag.id?' dragging':'')} data-world-tag-id={tag.id}>
                <button type="button" className="filter-tag-drag" aria-label={'调整'+tag.name+'的顺序，拖动或使用上下方向键'} title="拖动排序（键盘 ↑ ↓）" disabled={sorting} onPointerDown={event=>startDrag(event,tag.id)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} onKeyDown={event=>moveWithKeyboard(event,tag.id)}><GripVertical size={15}/></button>
                <button type="button" className="filter-tag-select" aria-pressed={selectedIds.includes(tag.id)} onClick={()=>toggleTag(tag.id)}>{selectedIds.includes(tag.id)?<CheckSquare2 size={15}/>:<Square size={15}/>}<span title={tag.name}>{tag.name}</span></button>
              </div>)}
            </div>
            {selectedIds.length>0&&<button type="button" className="filter-clear" onClick={()=>setSelectedIds([])}>清除标签筛选</button>}
          </aside></>}
        <section className="library-body">
          <div className="library-controls"><div><h2>{filtered?'筛选结果':'我的世界'} <span>{items.length}{list.value?.hasMore?'+':''}</span></h2><p>{selectedIds.length?('已选 '+selectedIds.length+' 个标签 · '+(matchMode==='all'?'全部匹配':'部分匹配')):'选择世界并开始故事'}</p></div><SearchInput value={search} onChange={setSearch} placeholder="搜索世界名称…"/></div>
          {!items.length?<div className="library-no-match"><Empty text="没有找到符合条件的世界卡"/><button className="button secondary" onClick={clearFilters}>清除筛选条件</button></div>:
          <div className="world-showcase">{items.map((w:any)=>
            <Link
              key={w.id}
              to={'/worlds/'+w.id}
              className={'showcase-card immersive-world-card'+(!w.cover?' no-art':'')}
              style={w.cover?{backgroundImage:`url(${JSON.stringify(w.cover)})`}:undefined}
              aria-label={`查看世界：${w.name}，${w.sessionCount??0} 个会话`}
            >
              <div className="immersive-world-card-info">
                <h3 title={w.name}>{w.name}</h3>
                <div className="immersive-world-card-meta">
                  <div className="showcase-tags">{(w.tags??[]).map((tag:any)=><span key={tag.id}>{tag.name}</span>)}</div>
                  <span className="showcase-count">{w.sessionCount??0} 个会话</span>
                </div>
              </div>
            </Link>
          )}</div>}
          {list.value?.hasMore&&<button className="button secondary load-more" disabled={list.loading} onClick={list.more}>{list.loading?'加载中…':'加载更多世界'}</button>}
        </section>
      </div>}
  </main>;
}
