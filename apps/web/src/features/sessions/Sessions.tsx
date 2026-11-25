import {errorKey} from '../../i18n/errors.ts';
import {useTranslation} from 'react-i18next';
import {i18n} from '../../i18n/instance.ts';
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
import type {SessionSummary} from './types';

export function SessionListPage(){
  useTranslation();
 const [query,setQuery]=useSearchParams(),worldId=query.get('worldId')??'';
 const {sessionsRevision,refreshSessions}=useManagement();
 const list=usePagedResource<SessionSummary>('v1/sessions?limit=20'+(worldId?'&worldId='+encodeURIComponent(worldId):''),sessionsRevision);
 const pending=useRef(false);const [creating,setCreating]=useState(false),[confirmation,setConfirmation]=useState<SessionSummary|null>(null),[failure,setFailure]=useState(''),[deleting,setDeleting]=useState(false);
 const remove=async()=>{
  if(!confirmation||pending.current)return;pending.current=true;setDeleting(true);setFailure('');
  try{await api('v1/sessions/'+encodeURIComponent(confirmation.id),{method:'DELETE'});refreshSessions();setConfirmation(null);}
  catch(reason){setFailure(errorKey(reason,"common:deleteFailed"));}
  finally{pending.current=false;setDeleting(false);}
 };
 return <section className={styles.listPage}>
  <PageHeader title={i18n.t("common:sessions")} actions={<Button variant="primary" icon={<Plus size={16}/>} onClick={()=>setCreating(true)}>{i18n.t("sessions:create")}</Button>}/>
  {worldId&&<div className="library-controls"><Link to={'/worlds/'+encodeURIComponent(worldId)+'?tab=sessions'}>{i18n.t("sessions:backToWorld")}</Link> · <Button variant="text" onClick={()=>setQuery({})}>{i18n.t("sessions:allSessions")}</Button></div>}
  {list.error&&<ErrorNotice message={list.error} onRetry={()=>list.page?void list.more():list.reload()}/>}
  {list.loading&&!list.page&&<Loading/>}
  <div className={styles.list}>{list.page?.items.map(item=><SessionRow key={item.id} id={item.id} worldId={item.worldId} title={item.title} updatedAt={item.updatedAt} cover={item.cover} actions={<IconButton intent="danger" disabled={deleting} aria-label={i18n.t("common:delete")+(item.title||i18n.t("common:untitledSession"))} onClick={()=>{setFailure('');setConfirmation(item);}}><Trash2 size={17}/></IconButton>}/>)}</div>
  {list.page?.items.length===0&&<div className="empty"><h2>{worldId?i18n.t("sessions:worldHasNoSessions"):i18n.t("sessions:empty")}</h2><p>{i18n.t("sessions:emptyHint")}</p></div>}
  {list.page?.hasMore&&<Button disabled={list.loading} onClick={()=>void list.more()}>{i18n.t("common:loadMore")}</Button>}
  {creating&&<CreateSessionDialog worldId={worldId} onClose={()=>setCreating(false)}/>}
  {confirmation&&<Modal title={i18n.t("sessions:deleteSession")} onBeforeClose={()=>!pending.current} onClose={()=>setConfirmation(null)} footer={<><Button disabled={deleting} onClick={()=>setConfirmation(null)}>{i18n.t("common:cancel")}</Button><Button variant="primary" intent="danger" loading={deleting} onClick={()=>void remove()}>{i18n.t("common:confirmDelete")}</Button></>}><p>{i18n.t("sessions:deleteConfirmation",{name:confirmation.title||i18n.t("common:untitledSession")})}</p>{failure&&<ErrorNotice message={failure}/>}</Modal>}
 </section>;
}

export function SessionDetailPage(){
  useTranslation();const {sessionId}=useParams();return <SessionPage key={sessionId} id={sessionId!}/>;}
