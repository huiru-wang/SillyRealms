import {useEffect,useRef,useState} from 'react';
import {Link,useNavigate,useParams,useSearchParams} from 'react-router-dom';
import {Plus,Trash2} from 'lucide-react';
import {Button,IconButton} from '../../components/ui/Button';
import {Input,Panel} from '../../components/ui/Field';
import {Select} from '../../components/ui/Select';
import {Modal} from '../../components/ui/Modal';
import {PageHeader} from '../../components/ui/PageHeader';
import {api,ApiError,json} from '../../api';
import {usePagedResource,useResource} from '../../data';
import {ErrorNotice,Loading} from '../../app/ui';
import {useManagement} from '../../app/ManagementData';
import {usePresetStore} from '../presets/PresetStore';
import type {ModelConfig} from '../models/types';
import {SessionRow} from './SessionRow';
import styles from './Sessions.module.css';

import {CreateSessionDialog} from './CreateSessionDialog';
import type {Session} from './types';
import type {WorldDetail as WorldChoice} from '../worlds/api/worlds';

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

export function SessionDetailPage(){const {sessionId}=useParams();return <SessionEditor key={sessionId} id={sessionId!}/>;}
function SessionEditor({id}:{id:string}){
 const {modelsRevision,refreshSessions}=useManagement(),presets=usePresetStore(),navigate=useNavigate();
 const session=useResource<{item:Session}>('v1/sessions/'+encodeURIComponent(id));
 const models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
 const item=session.value?.item;
 const world=useResource<{item:WorldChoice}>(item?'v1/worlds/'+encodeURIComponent(item.worldId):null);
 const [draft,setDraft]=useState<{title:string;presetId:string;apiModelConfigId:string}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[deleting,setDeleting]=useState(false);
 const pending=useRef(false);
 useEffect(()=>{if(item)setDraft({title:item.title??'',presetId:item.presetId,apiModelConfigId:item.apiModelConfigId});},[item]);
 const save=async()=>{
  if(!item||!draft||pending.current)return;
  const patch:Partial<Pick<Session,'title'|'presetId'|'apiModelConfigId'>>={};
  if((draft.title.trim()||null)!==item.title)patch.title=draft.title.trim()||null;
  if(draft.presetId!==item.presetId)patch.presetId=draft.presetId;
  if(draft.apiModelConfigId!==item.apiModelConfigId)patch.apiModelConfigId=draft.apiModelConfigId;
  if(!Object.keys(patch).length)return;
  pending.current=true;setBusy(true);setError('');setSaved(false);
  try{const result=await api<{item:Session}>('v1/sessions/'+encodeURIComponent(id),{method:'PATCH',body:json(patch)});session.replace(result);refreshSessions();setSaved(true);}
  catch(reason){setError(reason instanceof Error?reason.message:'保存失败');}
  finally{pending.current=false;setBusy(false);}
 };
 const remove=async()=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{await api('v1/sessions/'+encodeURIComponent(id),{method:'DELETE'});refreshSessions();navigate('/sessions');}
  catch(reason){setError(reason instanceof Error?reason.message:'删除失败');}
  finally{pending.current=false;setBusy(false);}
 };
 const valid=!!draft&&!!draft.presetId&&!!draft.apiModelConfigId;
 return <section className="page settings-page">
  <PageHeader title="会话详情" actions={<Button intent="danger" variant="ghost" disabled={!item||busy} onClick={()=>{setError('');setDeleting(true);}}>删除会话</Button>}/>
  <Link to="/sessions">返回会话列表</Link>
  {session.loading&&<Loading/>}{session.error&&<ErrorNotice message={session.error} onRetry={session.reload}/>}
  {item&&draft&&<Panel className="settings-group"><div className="settings-group-title"><div><h2>{item.worldName}</h2><p>玩家角色：{world.value?.item.characters.find(c=>c.id===item.userCharacterId)?.name??item.userCharacterId}</p></div></div>
   <div className="settings-rows">
    <label className="settings-row"><span>标题</span><Input aria-label="会话标题" disabled={busy} value={draft.title} onChange={e=>{setDraft({...draft,title:e.target.value});setSaved(false);}}/></label>
    <label className="settings-row"><span>预设</span><Select aria-label="会话预设" disabled={busy} value={draft.presetId} onChange={e=>{setDraft({...draft,presetId:e.target.value});setSaved(false);}}>{!presets.presets.some(p=>p.id===draft.presetId)&&<option value={draft.presetId}>当前预设（列表尚未加载）</option>}{presets.presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label>
    <label className="settings-row"><span>模型</span><Select aria-label="会话模型" disabled={busy} value={draft.apiModelConfigId} onChange={e=>{setDraft({...draft,apiModelConfigId:e.target.value});setSaved(false);}}>{!models.page?.items.some(m=>m.id===draft.apiModelConfigId)&&<option value={draft.apiModelConfigId}>当前模型（列表尚未加载）</option>}{models.page?.items.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</Select></label>
    <div className="settings-row settings-row-action"><Button variant="primary" loading={busy} disabled={!valid} onClick={()=>void save()}>保存会话</Button></div>
   </div>
  </Panel>}
  {presets.error&&<ErrorNotice message={presets.error} onRetry={presets.reload}/>}{models.error&&<ErrorNotice message={models.error} onRetry={models.reload}/>}{world.error&&<ErrorNotice message={world.error} onRetry={world.reload}/>}
  {error&&!deleting&&<ErrorNotice message={error}/>} {saved&&<p role="status">会话配置已保存。</p>}
  {deleting&&<Modal title="删除会话" onBeforeClose={()=>!pending.current} onClose={()=>setDeleting(false)} footer={<><Button disabled={busy} onClick={()=>setDeleting(false)}>取消</Button><Button variant="primary" intent="danger" loading={busy} onClick={()=>void remove()}>确认删除</Button></>}><p>删除此会话及其所属历史？</p>{error&&<ErrorNotice message={error}/>}</Modal>}
 </section>;
}
