import {Button,IconButton} from '../../components/ui/Button';
import {Modal} from '../../components/ui/Modal';
import {PageHeader} from '../../components/ui/PageHeader';
import {Link,useParams} from 'react-router-dom';
import {Trash2} from 'lucide-react';
import {SessionHost} from '../../host';
import {api} from '../../api';
import {usePaged,ErrorNotice,Loading} from '../../app/ui';
import {useRef,useState} from 'react';
import styles from './Sessions.module.css';
import {SessionRow} from './SessionRow';
export function SessionDetailPage(){const {sessionId}=useParams();return <SessionHost key={sessionId} id={sessionId!}/>;}
export function SessionListPage(){
 const {value,error,loading,reload,more}=usePaged('v1/sessions?limit=20');
 const pending=useRef(false);
 const [confirmation,setConfirmation]=useState<{id:string;title:string}|null>(null);
 const [failure,setFailure]=useState(''),[deleting,setDeleting]=useState<string|null>(null);
 async function remove(id:string){if(pending.current)return;pending.current=true;setDeleting(id);setFailure('');try{await api('v1/sessions/'+encodeURIComponent(id),{method:'DELETE'});await reload();window.dispatchEvent(new Event('sr:catalog-changed'));setConfirmation(null);}catch(error){setFailure(error instanceof Error?error.message:'删除失败');}finally{pending.current=false;setDeleting(null);}}
 return <section className={styles.listPage}><PageHeader title="会话"/>
 {(error||(!confirmation&&failure))&&<ErrorNotice message={error||failure} onRetry={reload}/>}{loading&&!value&&<Loading/>}
 <div className={styles.list}>{value?.items?.map((item:any)=><SessionRow key={item.id} id={item.id} worldId={item.worldId} title={item.title} updatedAt={item.updatedAt} cover={item.cover} actions={<IconButton intent="danger" aria-label={'删除'+(item.title||'未命名会话')} disabled={deleting!==null} onClick={()=>{setFailure('');setConfirmation({id:item.id,title:item.title||'未命名会话'});}}><Trash2 size={17}/></IconButton>}/>)}</div>
 {value?.items?.length===0&&<div className="empty"><h2>还没有会话</h2><p>选择一个世界和开局，开始故事。</p><Link to="/worlds">浏览世界卡</Link></div>}
 {value?.hasMore&&<Button variant="secondary" disabled={loading} onClick={more}>加载更多</Button>}
 {confirmation&&<Modal title="删除会话" onBeforeClose={()=>!pending.current} onClose={()=>setConfirmation(null)} footer={<><Button disabled={deleting!==null} onClick={()=>setConfirmation(null)}>取消</Button><Button variant="primary" intent="danger" loading={deleting!==null} onClick={()=>void remove(confirmation.id)}>确认删除</Button></>}><p>删除“{confirmation.title}”及其历史？此操作无法撤销。</p>{failure&&<ErrorNotice message={failure}/>}</Modal>}
 </section>;
}
