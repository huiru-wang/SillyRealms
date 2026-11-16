import {Link,useParams} from 'react-router-dom';
import {Trash2} from 'lucide-react';
import {SessionHost} from '../../host';
import {api} from '../../api';
import {usePaged,ErrorNotice,Loading} from '../../app/ui';
import {useState} from 'react';
import styles from './Sessions.module.css';
import {SessionRow} from './SessionRow';
export function SessionDetailPage(){const {sessionId}=useParams();return <SessionHost key={sessionId} id={sessionId!}/>;}
export function SessionListPage(){
 const {value,error,loading,reload,more}=usePaged('v1/sessions?limit=20');
 const [failure,setFailure]=useState(''),[deleting,setDeleting]=useState<string|null>(null);
 async function remove(id:string){if(!confirm('删除此会话及其历史？'))return;setDeleting(id);setFailure('');try{await api('v1/sessions/'+encodeURIComponent(id),{method:'DELETE'});await reload();window.dispatchEvent(new Event('sr:catalog-changed'));}catch(error){setFailure(error instanceof Error?error.message:'删除失败');}finally{setDeleting(null);}}
 return <section className={styles.listPage}><header className={styles.listHeader}><h1>会话</h1></header>
 {(error||failure)&&<ErrorNotice message={error||failure} onRetry={reload}/>}{loading&&!value&&<Loading/>}
 <div className={styles.list}>{value?.items?.map((item:any)=><SessionRow key={item.id} id={item.id} worldId={item.worldId} title={item.title} updatedAt={item.updatedAt} cover={item.cover} actions={<button aria-label={'删除'+(item.title||'未命名会话')} disabled={deleting!==null} onClick={()=>void remove(item.id)}><Trash2 size={17}/></button>}/>)}</div>
 {value?.items?.length===0&&<div className="empty"><h2>还没有会话</h2><p>选择一个世界和开局，开始故事。</p><Link to="/worlds">浏览世界卡</Link></div>}
 {value?.hasMore&&<button className="button" disabled={loading} onClick={more}>加载更多</button>}</section>;
}
