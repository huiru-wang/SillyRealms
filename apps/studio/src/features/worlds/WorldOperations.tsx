import {Select} from '../../components/ui/Select';
import {useSRAssetBaseUrl} from '@sillyrealms/sdk';
import {createPortal} from 'react-dom';
import {Ellipsis} from 'lucide-react';
import {useEffect,useRef,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {api,json} from '../../api';
import {useLoad,ErrorNotice} from '../../app/ui';
import {safeImage,type WorldDetail} from './api/worlds';
import {Modal} from '../../components/ui/Modal';
import {Button} from '../../components/ui/Button';
import styles from './WorldDetailPage.module.css';
// Primary: start/save. Secondary: configuration. Uses Studio surface/text/spacing tokens.
export function StartSession({world,openingId,characterId}:{world:WorldDetail;openingId:string;characterId?:string}){
 const assetBaseUrl=useSRAssetBaseUrl();
 const role=world.data.characters.find(character=>character.id===characterId&&character.player_selectable);
 const opening=world.data.openings.find(item=>item.id===openingId);
 const [confirmation,setConfirmation]=useState<{openingId:string;openingName:string;characterId:string;characterName:string;avatar?:string}|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const submitting=useRef(false);
 const navigate=useNavigate();
 function close(){if(!submitting.current)setConfirmation(null);}
 async function start(){
  if(!confirmation||submitting.current)return;
  submitting.current=true;setBusy(true);setError('');
  try{const result=await api('v1/sessions',{method:'POST',body:json({worldId:world.id,openingId:confirmation.openingId,userCharacterId:confirmation.characterId,title:confirmation.openingName})});window.dispatchEvent(new Event('sr:catalog-changed'));navigate('/sessions/'+encodeURIComponent(result.item.id));}
  catch(e){setError(e instanceof Error?e.message:'创建失败');}
  finally{submitting.current=false;setBusy(false);}
 }
 return <>
  <Button size="compact" variant="primary" disabled={!role||!opening||busy} onClick={()=>{if(role&&opening){setError('');setConfirmation({openingId:opening.id,openingName:opening.name,characterId:role.id,characterName:role.name,avatar:role.avatar});}}}>开始会话</Button>
  {confirmation&&<Modal title="开始会话" onClose={close} onBeforeClose={()=>!submitting.current} footer={<><Button disabled={busy} onClick={close}>取消</Button><Button variant="primary" loading={busy} onClick={()=>void start()}>{busy?'正在创建…':'确认开始'}</Button></>}>
   <dl className={styles.startSummary} aria-busy={busy}>
    <div><dt>开局</dt><dd>{confirmation.openingName}</dd></div>
    <div><dt>扮演角色</dt><dd><span className={styles.startAvatar} aria-hidden="true">{safeImage(confirmation.avatar,assetBaseUrl)?<img src={safeImage(confirmation.avatar,assetBaseUrl)} alt=""/>:confirmation.characterName.slice(0,1)}</span><span>{confirmation.characterName}</span></dd></div>
   </dl>
   {error&&<p className={styles.startFailure} role="alert">{error}</p>}
  </Modal>}
 </>;
}
export function WorldConfig({world}:{world:WorldDetail}){
 const presets=useLoad('v1/presets?limit=100',true),models=useLoad('v1/api-model-configs');
 const [preset,setPreset]=useState(world.defaultPresetId??''),[model,setModel]=useState(world.defaultApiModelConfigId??'');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 const valid=!!presets.value?.items?.some((p:any)=>p.id===preset)&&!!models.value?.items?.some((m:any)=>m.id===model);
 async function save(){if(!valid){setError('请选择有效的预设和模型。');return;}setBusy(true);setError('');setSaved(false);try{await api('v1/worlds/'+encodeURIComponent(world.id),{method:'PATCH',body:json({defaultPresetId:preset,defaultApiModelConfigId:model})});window.dispatchEvent(new CustomEvent('sr:world-config',{detail:{id:world.id,defaultPresetId:preset,defaultApiModelConfigId:model}}));setSaved(true);}catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}}
 return <div className="business-form">{(error||presets.error||models.error)&&<ErrorNotice message={error||presets.error||models.error} onRetry={()=>{void presets.reload();void models.reload();}}/>}<label>预设<Select required aria-label="预设" disabled={!presets.value?.items?.length} value={preset} onChange={e=>{setPreset(e.target.value);setSaved(false);}}><option value="" disabled>请选择预设</option>{presets.value?.items?.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></label><label>模型<Select required aria-label="模型" disabled={!models.value?.items?.length} value={model} onChange={e=>{setModel(e.target.value);setSaved(false);}}><option value="" disabled>请选择模型</option>{models.value?.items?.map((m:any)=><option key={m.id} value={m.id}>{m.name}{!m.credentialConfigured?'（缺少凭据）':''}</option>)}</Select></label><Button variant="primary" loading={busy} disabled={!valid} onClick={()=>void save()}>{busy?'保存中…':'保存配置'}</Button>{saved&&<p role="status">运行配置已保存</p>}</div>;
}
export function WorldActions({world}:{world:WorldDetail}){
 const [confirm,setConfirm]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [menu,setMenu]=useState<{top:number;right:number}|null>(null),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
 const navigate=useNavigate();
 const closeMenu=(focus=false)=>{setMenu(null);if(focus)trigger.current?.focus();};
 useEffect(()=>{
  if(!menu)return;
  panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  const outside=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node)&&!trigger.current?.contains(event.target as Node))setMenu(null);};
  const dismiss=()=>setMenu(null);
  document.addEventListener('pointerdown',outside);window.addEventListener('resize',dismiss);
  return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',dismiss);};
 },[menu]);
 async function remove(){setBusy(true);setError('');try{await api('v1/worlds/'+encodeURIComponent(world.id),{method:'DELETE'});window.dispatchEvent(new Event('sr:catalog-changed'));navigate('/worlds');}catch(e){setError(e instanceof Error?e.message:'删除失败');}finally{setBusy(false);}}
 function openMenu(){const bounds=trigger.current?.getBoundingClientRect();if(bounds)setMenu({top:bounds.bottom+6,right:Math.max(16,window.innerWidth-bounds.right)});}
 return <><button ref={trigger} className="world-more-button" aria-label="世界卡更多操作" aria-haspopup="menu" aria-expanded={!!menu} onClick={()=>menu?closeMenu():openMenu()} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();openMenu();}}}><Ellipsis size={20}/></button>
 {menu&&createPortal(<div ref={panel} className="world-more-menu" style={menu} role="menu" aria-label="世界卡操作" onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();closeMenu(true);}
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));const index=items.indexOf(document.activeElement as HTMLElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
 }} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget)&&event.relatedTarget!==trigger.current)closeMenu();}}>
 <a role="menuitem" href={'/api/v1/worlds/'+encodeURIComponent(world.id)+'/export'} onClick={()=>closeMenu(true)}>导出世界卡</a>
 <button role="menuitem" onClick={()=>{closeMenu(true);setConfirm(true);}}>删除世界卡</button>
 </div>,document.body)}
 {confirm&&<Modal title="删除世界卡" onBeforeClose={()=>!busy} onClose={()=>{setConfirm(false);trigger.current?.focus();}}><p>删除“{world.data.name}”及其全部会话和历史？此操作无法撤销。</p>{error&&<ErrorNotice message={error}/>}<div className="actions"><Button disabled={busy} onClick={()=>{setConfirm(false);trigger.current?.focus();}}>取消</Button><Button variant="primary" intent="danger" loading={busy} onClick={()=>void remove()}>{busy?'删除中…':'确认删除'}</Button></div></Modal>}</>;
}
