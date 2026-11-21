import {createPortal} from 'react-dom';
import {Ellipsis} from 'lucide-react';
import {restoreDialogFocus} from '../../components/ui/focus';
import {WorldMetadataForm} from './WorldForms';
import {useEffect,useRef,useState} from 'react';
import {useNavigate,Link} from 'react-router-dom';
import {Button} from '../../components/ui/Button';
import {Modal} from '../../components/ui/Modal';
import {ErrorNotice} from '../../app/ui';
import {useManagement} from '../../app/ManagementData';
import {api,ApiError} from '../../api';
import {downloadWorld} from './download';
import type {WorldDetail} from './api/worlds';

export function WorldActions({world,onSaved}:{world:WorldDetail;onSaved:(world:WorldDetail)=>void}){
 const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [deleteWarning,setDeleteWarning]=useState<{worldId:string;message:string}|null>(null);
 const warning=deleteWarning?.worldId===world.id?deleteWarning:null;
 const [editing,setEditing]=useState(false);
 const [menu,setMenu]=useState<{top:number;right:number}|null>(null),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const closeMenu=(focus=false,keyboard=false)=>{setMenu(null);if(focus&&trigger.current)restoreDialogFocus(trigger.current,keyboard);};
 useEffect(()=>{
  if(!menu)return;
  panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  const outside=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))setMenu(null);};
  const dismiss=()=>setMenu(null);
  document.addEventListener('pointerdown',outside);window.addEventListener('resize',dismiss);
  return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',dismiss);};
 },[menu]);
 function openMenu(){const bounds=trigger.current?.getBoundingClientRect();if(bounds)setMenu({top:bounds.bottom+6,right:Math.max(16,window.innerWidth-bounds.right)});}
 const pending=useRef(false),navigate=useNavigate();const {refreshWorlds,refreshSessions,rememberWorldCleanup}=useManagement();
 useEffect(()=>{setConfirm(false);setDeleteWarning(null);setError('');},[world.id]);
 const closeConfirmation=()=>{if(pending.current)return;setConfirm(false);setDeleteWarning(null);setError('');};
 const afterDelete=()=>{refreshWorlds();refreshSessions();navigate('/worlds');};
 const download=async(kind:'export'|'original')=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{await downloadWorld(world.id,kind);}catch(reason){setError(reason instanceof Error?reason.message:'下载失败');}
  finally{pending.current=false;setBusy(false);}
 };
 const remove=async()=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{await api('v1/worlds/'+encodeURIComponent(world.id)+(warning?'?deleteSessions=true':''),{method:'DELETE'});afterDelete();}
  catch(reason){
   if(reason instanceof ApiError&&reason.errorCode==='WORLD_HAS_SESSIONS')setDeleteWarning({worldId:world.id,message:reason.message});
   else if(reason instanceof ApiError&&reason.errorCode==='WORLD_FILES_DELETE_FAILED'){rememberWorldCleanup({id:world.id,name:world.name});afterDelete();}
   else if(reason instanceof ApiError&&reason.errorCode==='WORLD_NOT_FOUND')afterDelete();
   else setError(reason instanceof Error?reason.message:'删除失败');
  }finally{pending.current=false;setBusy(false);}
 };
 return <><button ref={trigger} className="world-more-button" disabled={busy} aria-label="世界卡更多操作" aria-haspopup="menu" aria-expanded={!!menu} onClick={()=>menu?closeMenu():openMenu()} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();openMenu();}}}><Ellipsis size={20}/></button>
  {menu&&createPortal(<div ref={panel} className="world-more-menu" style={menu} role="menu" aria-label="世界卡操作" onKeyDown={event=>{
   if(event.key==='Escape'){event.preventDefault();closeMenu(true,true);}
   if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));const index=items.indexOf(document.activeElement as HTMLElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
  }} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget)&&event.relatedTarget!==trigger.current)closeMenu();}}>
   <button role="menuitem" onClick={()=>{closeMenu(true);setEditing(true);}}>编辑名称与标签</button>
   <button role="menuitem" onClick={()=>{closeMenu(true);void download('export');}}>导出世界卡</button>
   <button role="menuitem" onClick={()=>{closeMenu(true);void download('original');}}>下载导入原件</button>
   <button role="menuitem" onClick={()=>{closeMenu(true);setError('');setDeleteWarning(null);setConfirm(true);}}>删除世界卡</button>
  </div>,document.body)}
  {editing&&<Modal title="名称与标签" onClose={()=>setEditing(false)}><WorldMetadataForm world={world} onSaved={item=>{onSaved(item);setEditing(false);}}/></Modal>}
  {error&&!confirm&&<Modal title="世界卡操作失败" onClose={()=>setError('')}><ErrorNotice message={error}/></Modal>}
  {confirm&&<Modal title={warning?'删除世界及会话':'删除世界'} onBeforeClose={()=>!pending.current} onClose={closeConfirmation} footer={<><Button disabled={busy} onClick={closeConfirmation}>取消</Button><Button variant="primary" intent="danger" loading={busy} onClick={()=>void remove()}>{warning?'删除世界及会话':'确认删除'}</Button></>}><p>删除“{world.name}”及其包内文件？此操作无法撤销。</p><Link to={'/sessions?worldId='+encodeURIComponent(world.id)} aria-disabled={busy} onClick={event=>{if(pending.current)event.preventDefault();else closeConfirmation();}}>查看关联会话</Link>{warning&&<ErrorNotice message={warning.message}/>} {error&&<ErrorNotice message={error}/>}</Modal>}
 </>;
}
export function WorldCleanupNotice(){
 const {worldCleanup,forgetWorldCleanup}=useManagement(),pending=useRef(false);
 const [busy,setBusy]=useState(''),[error,setError]=useState('');
 async function retry(id:string){
  if(pending.current)return;pending.current=true;setBusy(id);setError('');
  try{await api('v1/worlds/'+encodeURIComponent(id),{method:'DELETE'});forgetWorldCleanup(id);}
  catch(reason){if(reason instanceof ApiError&&reason.errorCode==='WORLD_NOT_FOUND')forgetWorldCleanup(id);else setError(reason instanceof Error?reason.message:'清理失败');}
  finally{pending.current=false;setBusy('');}
 }
 return <>{worldCleanup.map(item=><div key={item.id} role="alert"><p>“{item.name}”的记录已删除，文件清理未完成。</p><Button disabled={!!busy} loading={busy===item.id} onClick={()=>void retry(item.id)}>重试清理文件</Button></div>)}{error&&<ErrorNotice message={error}/>}</>;
}
