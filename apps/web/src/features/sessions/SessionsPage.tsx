import React,{useState} from 'react';
import {Link} from 'react-router-dom';
import {ArrowRight,BookOpen,ChevronRight,Clock3,MoreHorizontal,Plus,Trash2} from 'lucide-react';
import {api} from '../../api';
import {Empty,ErrorNotice,Header,Loading,SearchInput,usePaged} from '../../app/ui';

/** Primary: continue a story. Delete is a tertiary action behind a per-row menu. */
export function SessionsPage(){
  const {value,error,reload,more,loading}=usePaged('v1/sessions?limit=100');
  const [query,setQuery]=useState(''),[menu,setMenu]=useState<string|null>(null),[feedback,setFeedback]=useState('');
  const items=(value?.items??[]).filter((s:any)=>[s.title,s.worldName].some(v=>String(v??'').toLowerCase().includes(query.trim().toLowerCase())));
  const remove=async(id:string)=>{
    if(!confirm('永久删除此会话及其消息记录？此操作无法撤销。'))return;
    setMenu(null);
    try{await api('v1/sessions/'+id,{method:'DELETE'});await reload();setFeedback('会话已删除');}
    catch(e){setFeedback(e instanceof Error?e.message:String(e));}
  };
  return <main className="page sessions-page">
    <Header eyebrow="YOUR STORIES" title="会话" description="回到正在进行的故事，或者探索一个新世界。"><Link className="button primary" to="/worlds"><Plus size={16}/> 新建会话</Link></Header>
    {feedback&&<div className="notice" role="status">{feedback}<button onClick={()=>setFeedback('')}>关闭</button></div>}
    {error&&<ErrorNotice message={error} onRetry={reload}/>}
    {!value&&loading?<Loading text="正在读取会话…"/>:!value?.items?.length?<div className="session-empty"><BookOpen size={30}/><h2>你的故事从这里开始</h2><p>选择喜欢的世界，开启属于你的新故事。</p><Link to="/worlds" className="button primary">探索世界 <ArrowRight size={16}/></Link></div>:<>
      <section className="session-section-head"><div><h2>最近会话 <span>{items.length}</span></h2><p>按最近活动排序</p></div><SearchInput value={query} onChange={setQuery} placeholder="搜索会话或世界…"/></section>
      <div className="session-collection">{items.length?items.map((s:any)=><article className="session-item" key={s.id}>
        <Link to={'/sessions/'+s.id} className="session-item-main">
          <div className="session-world-cover" style={s.cover?{backgroundImage:`url(${JSON.stringify(s.cover)})`}:undefined}>{!s.cover&&<BookOpen size={21}/>}</div>
          <div className="session-item-label"><h3>{s.title||s.worldName||'未命名会话'}</h3><p>{s.worldName||'未知世界'} <span>·</span> <Clock3 size={12}/> {new Date(s.updatedAt).toLocaleDateString('zh-CN')}</p></div>
          <span className="session-item-continue">继续故事 <ChevronRight size={16}/></span>
        </Link>
        <div className="session-item-menu"><button className="icon-button" title="更多操作" aria-label="更多操作" aria-expanded={menu===s.id} onClick={()=>setMenu(menu===s.id?null:s.id)}><MoreHorizontal size={19}/></button>{menu===s.id&&<div className="item-menu"><button onClick={()=>void remove(s.id)}><Trash2 size={15}/> 删除会话</button></div>}</div>
      </article>):<Empty text="没有找到匹配的会话"/>}</div>
      {value?.hasMore&&<button className="button secondary load-more" disabled={loading} onClick={more}>{loading?'加载中…':'加载更多'}</button>}
    </>}
  </main>;
}
