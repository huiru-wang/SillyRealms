import {useRef,useState} from 'react';
import {Link,useParams,useSearchParams} from 'react-router-dom';
import {Plus,Trash2} from 'lucide-react';
import {Button,IconButton} from '../../components/ui/Button';
import {Modal} from '../../components/ui/Modal';
import {PageHeader} from '../../components/ui/PageHeader';
import {api} from '../../api';
import {usePagedResource} from '../../data';
import {ErrorNotice,Loading} from '../../app/ui';
import {useManagement} from '../../app/ManagementData';
import {SessionRow} from './SessionRow';
import styles from './Sessions.module.css';

import {CreateSessionDialog} from './CreateSessionDialog';
import {SessionPage} from './SessionPage';
import type {Session} from './types';

export function SessionListPage(){
 const [query,setQuery]=useSearchParams(),worldId=query.get('worldId')??'';
 const {sessionsRevision,refreshSessions}=useManagement();
 const list=usePagedResource<Session>('v1/sessions?limit=20'+(worldId?'&worldId='+encodeURIComponent(worldId):''),sessionsRevision);
 const pending=useRef(false);const [creating,setCreating]=useState(false),[confirmation,setConfirmation]=useState<Session|null>(null),[failure,setFailure]=useState(''),[deleting,setDeleting]=useState(false);
 const remove=async()=>{
  if(!confirmation||pending.current)return;pending.current=true;setDeleting(true);setFailure('');
  try{await api('v1/sessions/'+encodeURIComponent(confirmation.id),{method:'DELETE'});refreshSessions();setConfirmation(null);}
  catch(reason){setFailure(reason instanceof Error?reason.message:'删除失败');}
  finally{pending.current=false;setDeleting(false);}
 };
 return <section className={styles.listPage}>
  <PageHeader title="会话" actions={<Button variant="primary" icon={<Plus size={16}/>} onClick={()=>setCreating(true)}>创建会话</Button>}/>
  {worldId&&<div className="library-controls"><Link to={'/worlds/'+encodeURIComponent(worldId)+'?tab=sessions'}>返回所属世界</Link> · <Button variant="text" onClick={()=>setQuery({})}>查看全部会话</Button></div>}
  {list.error&&<ErrorNotice message={list.error} onRetry={()=>list.page?void list.more():list.reload()}/>}
  {list.loading&&!list.page&&<Loading/>}
  <div className={styles.list}>{list.page?.items.map(item=><SessionRow key={item.id} id={item.id} worldId={item.worldId} title={item.title} updatedAt={item.updatedAt} cover={item.cover} actions={<IconButton intent="danger" disabled={deleting} aria-label={'删除'+(item.title||'未命名会话')} onClick={()=>{setFailure('');setConfirmation(item);}}><Trash2 size={17}/></IconButton>}/>)}</div>
  {list.page?.items.length===0&&<div className="empty"><h2>{worldId?'这个世界还没有会话':'还没有会话'}</h2><p>创建会话并设置玩家身份、预设和模型。</p></div>}
  {list.page?.hasMore&&<Button disabled={list.loading} onClick={()=>void list.more()}>加载更多</Button>}
  {creating&&<CreateSessionDialog worldId={worldId} onClose={()=>setCreating(false)}/>}
  {confirmation&&<Modal title="删除会话" onBeforeClose={()=>!pending.current} onClose={()=>setConfirmation(null)} footer={<><Button disabled={deleting} onClick={()=>setConfirmation(null)}>取消</Button><Button variant="primary" intent="danger" loading={deleting} onClick={()=>void remove()}>确认删除</Button></>}><p>删除“{confirmation.title||'未命名会话'}”及其所属历史？此操作无法撤销。</p>{failure&&<ErrorNotice message={failure}/>}</Modal>}
 </section>;
}

export function SessionDetailPage(){const {sessionId}=useParams();return <SessionPage key={sessionId} id={sessionId!}/>;}
