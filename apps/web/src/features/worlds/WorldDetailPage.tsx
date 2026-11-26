import {useTranslation} from 'react-i18next';
import {Button,IconButton} from '../../components/ui/Button';
import {SessionRow} from '../sessions/SessionRow';
import {WorldComponentCache} from './WorldComponentCache';
import {memo,useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type Dispatch,type KeyboardEvent,type RefObject,type SetStateAction,type TouchEvent as ReactTouchEvent,type UIEvent,type WheelEvent as ReactWheelEvent} from 'react';
import {Link,useParams,useSearchParams} from 'react-router-dom';
import {BookOpen,BookText,ChevronDown,ChevronLeft,ChevronRight,ChevronUp,Compass,Ellipsis,MessageCircle,Settings2,SlidersHorizontal} from 'lucide-react';
import {WorldDocumentRenderer} from '@sillyrealms/sdk/world-document';
import {useSRAssetBaseUrl} from '@sillyrealms/sdk';
import {WorldAssetsProvider} from '../../world-assets';
import {Modal} from '../../components/ui/Modal';
import type {Character,WorldDetail,WorldVersionsView} from './api/worlds';
import {api} from '../../api';
import {WorldPublication} from './WorldPublication';
import {worldReleaseIdentity} from './versions';
import {safeImage} from './resources';
import {usePagedResource,useResource} from '../../data';
import {useManagement} from '../../app/ManagementData';
import type {SessionSummary} from '../sessions/types';
import {CreateSessionDialog} from '../sessions/CreateSessionDialog';
import {WorldDefaultsForm as WorldConfig} from './WorldForms';
import {WorldActions} from './WorldActions';
import {libraryReturn} from './management';
import {LoreList} from './LoreList';
import {OpeningState,WorldState} from './StateInspector';
import styles from './WorldDetailPage.module.css';

type Section = 'overview'|'lore'|'state'|'openings'|'configuration'|'sessions';
const sections:{name:Section;tab:string;icon:typeof BookOpen}[]=[
  {name:'overview',tab:'overview',icon:BookOpen},{name:'lore',tab:'lore',icon:BookText},{name:'state',tab:'state',icon:SlidersHorizontal},
  {name:'openings',tab:'openings',icon:Compass},{name:'sessions',tab:'sessions',icon:MessageCircle},{name:'configuration',tab:'configuration',icon:Settings2}
];

type RoleAnchor = {index:number;fraction:number};
const clamp=(value:number,min=0,max=1)=>Math.min(max,Math.max(min,value));
const expandedOpacity=(progress:number)=>1-clamp((progress-.08)/.32);
const compactOpacity=(progress:number)=>clamp((progress-.6)/.3);

// Keep the visible character, rather than the pixel offset, across two densities.
function rolePositions(strip:HTMLDivElement){
  const left=strip.getBoundingClientRect().left;
  return Array.from(strip.querySelectorAll<HTMLButtonElement>('[data-role-action=details]')).map(button=>({
    button,left:button.getBoundingClientRect().left-left+strip.scrollLeft,width:button.offsetWidth
  }));
}
function readRoleAnchor(strip:HTMLDivElement):RoleAnchor{
  const roles=rolePositions(strip);
  let index=0;
  for(let i=1;i<roles.length;i++)if(roles[i].left<=strip.scrollLeft+1)index=i;
  const item=roles[index];
  if(!item)return {index:0,fraction:0};
  const step=(roles[index+1]?.left??item.left+item.width)-item.left;
  return {index,fraction:clamp((strip.scrollLeft-item.left)/step)};
}
function restoreRoleAnchor(strip:HTMLDivElement,anchor:RoleAnchor,expected:WeakMap<HTMLDivElement,number>){
  const roles=rolePositions(strip),item=roles[anchor.index];
  if(!item)return;
  const step=(roles[anchor.index+1]?.left??item.left+item.width)-item.left;
  const left=clamp(item.left+step*anchor.fraction,0,strip.scrollWidth-strip.clientWidth);
  expected.set(strip,left);
  strip.scrollLeft=left;
}
function RoleStrip({characters,compact,active,onChoose,onInspect,stripRef,contentKey}:{characters:readonly Character[];compact:boolean;active:number;onChoose:(i:number)=>void;onInspect:(i:number)=>void;stripRef:RefObject<HTMLDivElement|null>;contentKey:string}){
  const {t} = useTranslation('worlds');
  const assetBaseUrl=useSRAssetBaseUrl();
  const navigateRoles=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.altKey||event.ctrlKey||event.metaKey)return;
    const keys=['ArrowLeft','ArrowRight','Home','End'];
    if(!keys.includes(event.key))return;
    const strip=event.currentTarget;
    const action=(event.target as HTMLElement).dataset.roleAction;
    if(!action)return;
    const buttons=Array.from(strip.querySelectorAll<HTMLButtonElement>('[data-role-action="'+action+'"]'));
    const index=buttons.indexOf(event.target as HTMLButtonElement);
    if(index<0)return;
    event.preventDefault();
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:clamp(index+(event.key==='ArrowRight'?1:-1),0,buttons.length-1);
    const button=buttons[next];
    button.focus({preventScroll:true});
    const item=button.getBoundingClientRect(),view=strip.getBoundingClientRect();
    if(item.left<view.left)strip.scrollLeft+=item.left-view.left-3;
    else if(item.right>view.right)strip.scrollLeft+=item.right-view.right+3;
  };
  return <div className={[styles.roleStrip,compact?styles.roleStripCompact:''].join(' ')} ref={stripRef} role="group" aria-label={t('worldCharacters')} data-role-strip={compact?'compact':'expanded'} onKeyDown={navigateRoles}>
    {characters.map((character,i)=><div key={contentKey+character.id} className={[styles.role,active===i?styles.roleActive:''].join(' ')} data-role-card={character.id}>
      <button type="button" data-role-index={i} data-role-action="details" className={styles.roleProfile} title={character.name} aria-label={t('worlds:characterIntroduction',{name:character.name})} onClick={()=>onInspect(i)}>
        <span className={styles.roleAvatar} aria-hidden="true">{safeImage(character.avatar,assetBaseUrl)?<img src={safeImage(character.avatar,assetBaseUrl)} alt=""/>:<span>{character.name.slice(0,1)}</span>}</span>
        <span className={styles.roleName}>{character.name}</span>
      </button>
      {character.player_selectable&&<button type="button" className={styles.roleSelect} data-role-index={i} data-role-action="select" aria-label={t(active===i?'worlds:selectedCharacter':'worlds:playCharacter',{name:character.name})} aria-pressed={active===i} onClick={()=>onChoose(i)}>{active===i?t('selected'):t('playable')}</button>}
    </div>)}
  </div>;
}
function SessionSection({worldId}:{worldId:string}){
  const {t} = useTranslation('worlds');
  const {sessionsRevision}=useManagement();
  const {page,loading,error,more,reload}=usePagedResource<SessionSummary>('v1/sessions?worldId='+encodeURIComponent(worldId)+'&limit=20',sessionsRevision);
  const retry=()=>page?void more():reload();
  const [menu,setMenu]=useState<string|null>(null);
  return <>
    {loading&&!page&&<p role="status">{t('loadingSessions')}</p>}
    {error&&<div role="alert" className={styles.emptySessions}><strong>{t('couldNotLoadSessions')}</strong><button onClick={retry}>{t('retry')}</button></div>}
    {page&&page.items.length>0&&<div className={styles.sessionList}>{page.items.map(session=><SessionRow key={session.id} id={session.id} worldId={worldId} title={session.title} updatedAt={session.updatedAt} actions={<div className={styles.sessionActions} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setMenu(null);}} onKeyDown={event=>{if(event.key==='Escape')setMenu(null);}}><button className={styles.moreButton} aria-label={t('worlds:sessionActions',{name:session.title||t('worlds:untitledSession')})} aria-expanded={menu===session.id} onClick={()=>setMenu(menu===session.id?null:session.id)}><Ellipsis size={20}/></button>{menu===session.id&&<div className={styles.moreMenu}><Link to={'/sessions/'+encodeURIComponent(session.id)}>{t('manageSession')}</Link></div>}</div>}/>)}</div>}
    {!loading&&!error&&page?.items.length===0&&<div className={styles.emptySessions}><MessageCircle size={22} aria-hidden="true"/><strong>{t('noSessionsYet')}</strong><p>{t('storiesStartedInThisWorldWillAppear')}</p></div>}
    {page?.hasMore&&!error&&<Button disabled={loading} onClick={more}>{loading?t('loading'):t('loadMore')}</Button>}
  </>;
}
type DetailContentProps={section:Section;world:WorldDetail;characterId?:string;onSaved:(world:WorldDetail)=>void};
// Keep the preview pool at one DOM position: moving an iframe also reloads its document.
const WorldDetailContent=memo(function WorldDetailContent(props:DetailContentProps){
  const {t} = useTranslation('worlds');
  const {section,world}=props;
  const [openingId,setOpeningId]=useState(()=>world.openings[0]?.id??null);
  const openingIndex=Math.max(0,world.openings.findIndex(item=>item.id===openingId));
  const setOpeningIndex:Dispatch<SetStateAction<number>>=next=>{
    const index=typeof next==='function'?next(openingIndex):next;
    setOpeningId(world.openings[index]?.id??world.openings[0]?.id??null);
  };
  const opening=world.openings[openingIndex];
  const active=section==='overview'&&world.description&&typeof world.description!=='string'
    ?{id:'introduction',entry:world.description.component,title:t('worldIntroduction')}
    :section==='openings'&&opening?.component?{id:'opening:'+opening.id,entry:opening.component,title:opening.name}:null;
  const touch=useRef<number|null>(null);
  const frameCleanup=useRef<(()=>void)|null>(null);
  useLayoutEffect(()=>()=>{frameCleanup.current?.();frameCleanup.current=null;touch.current=null;},[section,opening?.id]);
  const finishSwipe=(end:number|undefined)=>{
    if(section==='openings'&&end!==undefined&&touch.current!==null&&Math.abs(end-touch.current)>50){
      const step=end<touch.current?1:-1;
      setOpeningIndex(i=>Math.max(0,Math.min(world.openings.length-1,i+step)));
    }
    touch.current=null;
  };
  return <div onTouchStart={event=>{touch.current=section!=='openings'||event.target instanceof Element&&event.target.closest('[role=dialog]')?null:event.touches[0]?.clientX??null;}} onTouchEnd={event=>finishSwipe(event.changedTouches[0]?.clientX)} onLoadCapture={event=>{
    if(section!=='openings'||!(event.target instanceof HTMLIFrameElement))return;
    // Prose documents are same-origin; author previews retain their isolated origin.
    const doc=event.target.contentDocument;if(!doc)return;
    frameCleanup.current?.();
    const start=(e:TouchEvent)=>{touch.current=e.touches[0]?.clientX??null;};
    const end=(e:TouchEvent)=>finishSwipe(e.changedTouches[0]?.clientX);
    doc.addEventListener('touchstart',start,{passive:true});doc.addEventListener('touchend',end,{passive:true});
    frameCleanup.current=()=>{doc.removeEventListener('touchstart',start);doc.removeEventListener('touchend',end);};
  }}>
    <SectionContent key={section+worldReleaseIdentity(world)} {...props} openingIndex={openingIndex} setOpeningIndex={setOpeningIndex}/>
    <WorldComponentCache world={world} active={active}/>
  </div>;
});
function SectionContent({section,world,characterId,onSaved,openingIndex,setOpeningIndex}:DetailContentProps&{openingIndex:number;setOpeningIndex:Dispatch<SetStateAction<number>>}){
  const {t} = useTranslation('worlds');
  const [stateOpen,setStateOpen]=useState(false);
  const data=world,opening=data.openings[openingIndex];
  if(section==='sessions')return <SessionSection worldId={world.id}/>;
  if(section==='lore')return <LoreList entries={data.lorebook?.entries??[]}/>;
  if(section==='state')return <WorldState state={data.stateDefinition??undefined}/>;
  if(section==='openings')return opening?<>
    <div className={styles.openingToolbar}><div className={styles.openingNav}><IconButton inset disabled={openingIndex===0} onClick={()=>setOpeningIndex(i=>i-1)} aria-label={t('previousOpening')}><ChevronLeft size={15}/></IconButton><span aria-label={t('worlds:openingPosition',{index:openingIndex+1,count:data.openings.length})}>{openingIndex+1}/{data.openings.length}</span><IconButton inset disabled={openingIndex===data.openings.length-1} onClick={()=>setOpeningIndex(i=>i+1)} aria-label={t('nextOpening')}><ChevronRight size={15}/></IconButton></div><div className={styles.openingActions}><Button size="compact" onClick={()=>setStateOpen(true)}>{t('viewInitialState')}</Button><StartSession world={world} openingId={opening.id} characterId={characterId}/></div></div>{!characterId&&<p className={styles.startError}>{t('thisWorldHasNoPlayableCharacters')}</p>}
    <h3>{opening.name}</h3>{!opening.component&&<WorldDocumentRenderer showStyleWarning={false} title={opening.name} content={opening.content}/>}
    {stateOpen&&<Modal title={t('openingState')} size="editor" onClose={()=>setStateOpen(false)}><OpeningState key={opening.id} openingName={opening.name} state={data.stateDefinition??undefined} override={opening.initial_state}/></Modal>}</>:<p>{t('thisWorldHasNoOpenings')}</p>;
  if(section==='configuration')return <WorldConfig world={world} onSaved={onSaved}/>;
  return typeof data.description==='string'?<WorldDocumentRenderer showStyleWarning={false} title={t('worldIntroduction')} content={data.description}/>:data.description?null:<p>{t('thisWorldHasNoIntroductionYet')}</p>;
}

function StartSession({world,openingId,characterId}:{world:WorldDetail;openingId:string;characterId?:string}){
  const {t} = useTranslation('worlds');
  const [open,setOpen]=useState(false);
  const character=world.characters.find(item=>item.id===characterId&&item.player_selectable);
  const opening=world.openings.find(item=>item.id===openingId);
  return <><Button size="compact" variant="primary" disabled={!character||!opening} onClick={()=>setOpen(true)}>{t('startSession')}</Button>
    {open&&character&&opening&&<CreateSessionDialog worldId={world.id} lockedWorld worldContext={{characterId:character.id,openingId:opening.id,openingName:opening.name}} onClose={()=>setOpen(false)}/>}
  </>;
}

export function WorldDetailPage(){
  const {t} = useTranslation('worlds');
  const {worldId}=useParams();
  const [query]=useSearchParams();
  const resource=useResource<{item:WorldDetail}>(worldId?'v1/worlds/'+encodeURIComponent(worldId):null);
  const {refreshWorlds}=useManagement();
  const world=resource.value?.item;
  const currentWorld=useRef(world);currentWorld.current=world;
  const summaryRead=useRef<AbortController|null>(null);
  useEffect(()=>()=>summaryRead.current?.abort(),[worldId]);
  const saved=(item:WorldDetail)=>{summaryRead.current?.abort();currentWorld.current=item;resource.replace({item});refreshWorlds();};
  const summarize=(view:WorldVersionsView)=>{
    const current=currentWorld.current;
    if(!current||current.id!==view.worldId)return;
    summaryRead.current?.abort();
    if(view.currentVersion!==current.currentVersion){
      // Another client may have installed a release since this detail was opened.
      const controller=new AbortController();summaryRead.current=controller;
      void api<{item:WorldDetail}>('v1/worlds/'+encodeURIComponent(current.id),{signal:controller.signal}).then(({item})=>{
        if(!controller.signal.aborted&&currentWorld.current?.id===item.id)saved(item);
      }).catch(()=>{/* Revision CAS protects an installation until the detail can be read again. */});
      refreshWorlds();return;
    }
    saved({...current,currentVersion:view.currentVersion,latestVersion:view.latestVersion,updateStatus:view.updateStatus});
  };
  if(!world)return <div className={styles.notFound}>{resource.error?<><h1>{t('couldNotLoadWorld')}</h1><p>{resource.error}</p><Button onClick={resource.reload}>{t('retry')}</Button> <Link to={libraryReturn(query.get('library'))}>{t('backToWorlds')}</Link></>:<p role="status">{t('loadingWorlds')}</p>}</div>;
  return <WorldAssetsProvider worldId={world.id}><WorldDetailView key={world.id} world={world} onSaved={saved} onSummary={summarize}/></WorldAssetsProvider>;
}
function WorldDetailView({world,onSaved,onSummary}:{world:WorldDetail;onSaved:(world:WorldDetail)=>void;onSummary:(view:WorldVersionsView)=>void}){
  const {t} = useTranslation('worlds');
  const worldId=world.id;
  const assetBaseUrl=useSRAssetBaseUrl();
  const names=world.characters.map(character=>character.name);
  const [roleDialog,setRoleDialog]=useState<number|null>(null);
  const [selectedCharacterId,setSelectedCharacterId]=useState(()=>world.characters.find(character=>character.player_selectable)?.id??null);
  const selectedIndex=world.characters.findIndex(character=>character.id===selectedCharacterId&&character.player_selectable);
  const selectedRole=selectedIndex>=0?selectedIndex:world.characters.findIndex(character=>character.player_selectable);
  const setSelectedRole=(index:number)=>{if(world.characters[index]?.player_selectable)setSelectedCharacterId(world.characters[index].id);};
  const contentKey=worldReleaseIdentity(world);
  useEffect(()=>setRoleDialog(null),[contentKey]);
  const [query,setQuery]=useSearchParams();
  const section=sections.find(item=>item.tab===query.get('tab'))?.name??'overview';
  const [progress,setProgress]=useState(0);
  const [reducedMotion,setReducedMotion]=useState(false);
  const page=useRef<HTMLDivElement>(null);
  const viewport=useRef<HTMLDivElement>(null);
  const content=useRef<HTMLElement>(null);
  const overviewToggle=useRef<HTMLButtonElement>(null);
  const overviewRoles=useRef<HTMLDivElement>(null);
  const compactRoles=useRef<HTMLDivElement>(null);
  const collapseRange=useRef(0);
  const animateOverview=useRef<(collapsed:boolean)=>void>(()=>{});
  const bottomCollapseRequested=useRef(false);
  const downwardIntentUntil=useRef(0);
  const touchY=useRef<number|null>(null);
  const roleAnchor=useRef<RoleAnchor>({index:0,fraction:0});
  const expectedRoleScroll=useRef(new WeakMap<HTMLDivElement,number>());
  const pendingRoleFocus=useRef<{index:number;action:string}|null>(null);
  const overviewRoleOpacity=reducedMotion?(progress<.5?1:0):expandedOpacity(progress);
  const compactRoleOpacity=reducedMotion?(progress>=.5?1:0):compactOpacity(progress);
  const overviewRoleVisible=overviewRoleOpacity>0;
  const compactVisible=compactRoleOpacity>0;
  const isCompact=progress>=.999;

  useLayoutEffect(()=>{
    const main=document.getElementById('main-content');
    const track=page.current,stage=viewport.current;
    if(!main||!track||!stage)return;
    const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame=0,animationFrame=0,settleTimer=0,wheelTimer=0,lastProgress=0;
    let animating=false,wheelLocked=false,touching=false;
    const update=()=>{
      const next=clamp(main.scrollTop/Math.max(1,collapseRange.current));
      // Move focus before making an outgoing strip inert; the incoming strip
      // receives the same character once it becomes visible.
      const active=document.activeElement as HTMLElement|null;
      const outgoing=overviewRoles.current?.contains(active)&&
        (motion.matches?next>=.5:expandedOpacity(next)===0)
        ||compactRoles.current?.contains(active)&&
        (motion.matches?next<.5:compactOpacity(next)===0);
      if(outgoing&&active?.dataset.roleIndex!==undefined){
        pendingRoleFocus.current={index:Number(active.dataset.roleIndex),action:active.dataset.roleAction??'details'};
        overviewToggle.current?.focus({preventScroll:true});
      }
      lastProgress=next;
      setProgress(next);
    };
    const queueUpdate=()=>{
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(update);
    };
    const measure=()=>{
      // This track has a fixed length independent of A's current height.
      // Observing the viewport (never A) avoids resize/scroll feedback loops.
      const nextRange=Math.max(1,track.offsetHeight-stage.clientHeight);
      if(Math.abs(nextRange-collapseRange.current)>.5){
        collapseRange.current=nextRange;
        main.scrollTo({top:lastProgress*nextRange,behavior:'instant'});
      }
      queueUpdate();
    };
    const moveTo=(collapsed:boolean)=>{
      cancelAnimationFrame(animationFrame);
      clearTimeout(settleTimer);
      const start=main.scrollTop,target=collapsed?collapseRange.current:0;
      if(motion.matches||Math.abs(start-target)<1){
        animating=false;
        main.scrollTo({top:target,behavior:'instant'});
        queueUpdate();
        return;
      }
      animating=true;
      const started=performance.now(),duration=380;
      const tick=(now:number)=>{
        const t=clamp((now-started)/duration);
        const eased=1-Math.pow(1-t,3);
        main.scrollTo({top:start+(target-start)*eased,behavior:'instant'});
        if(t<1)animationFrame=requestAnimationFrame(tick);
        else{animating=false;queueUpdate();}
      };
      animationFrame=requestAnimationFrame(tick);
    };
    animateOverview.current=moveTo;
    const onScroll=()=>{
      queueUpdate();
      if(animating||touching)return;
      clearTimeout(settleTimer);
      settleTimer=window.setTimeout(()=>{
        const position=main.scrollTop/Math.max(1,collapseRange.current);
        if(position>.001&&position<.999)moveTo(position>=.5);
      },140);
    };
    const onWheel=(event:WheelEvent)=>{
      if(event.ctrlKey||event.metaKey||Math.abs(event.deltaY)<=Math.abs(event.deltaX)||event.deltaY===0)return;
      if(content.current?.contains(event.target as Node))return;
      event.preventDefault();
      const locked=wheelLocked;
      wheelLocked=true;
      clearTimeout(wheelTimer);
      wheelTimer=window.setTimeout(()=>{wheelLocked=false;},180);
      if(locked||animating)return;
      moveTo(event.deltaY>0);
    };
    const onTouchStart=()=>{touching=true;clearTimeout(settleTimer);};
    const onTouchEnd=()=>{touching=false;onScroll();};
    const motionChanged=()=>{setReducedMotion(motion.matches);measure();};
    main.scrollTo({top:0,behavior:'instant'});
    setProgress(0);
    roleAnchor.current={index:0,fraction:0};
    pendingRoleFocus.current=null;
    bottomCollapseRequested.current=false;
    downwardIntentUntil.current=0;
    measure();
    motionChanged();
    const observer=new ResizeObserver(measure);
    observer.observe(stage);
    main.addEventListener('scroll',onScroll,{passive:true});
    main.addEventListener('wheel',onWheel,{passive:false});
    main.addEventListener('touchstart',onTouchStart,{passive:true});
    main.addEventListener('touchend',onTouchEnd,{passive:true});
    main.addEventListener('touchcancel',onTouchEnd,{passive:true});
    motion.addEventListener('change',motionChanged);
    return()=>{
      observer.disconnect();
      main.removeEventListener('scroll',onScroll);
      main.removeEventListener('wheel',onWheel);
      main.removeEventListener('touchstart',onTouchStart);
      main.removeEventListener('touchend',onTouchEnd);
      main.removeEventListener('touchcancel',onTouchEnd);
      motion.removeEventListener('change',motionChanged);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(animationFrame);
      clearTimeout(settleTimer);
      clearTimeout(wheelTimer);
      animateOverview.current=()=>{};
    };
  },[worldId]);

  useLayoutEffect(()=>{
    const expanded=overviewRoles.current,compact=compactRoles.current;
    if(!expanded||!compact)return;
    const sync=(source:HTMLDivElement,target:HTMLDivElement)=>{
      const expected=expectedRoleScroll.current.get(source);
      expectedRoleScroll.current.delete(source);
      if(expected!==undefined&&Math.abs(source.scrollLeft-expected)<1)return;
      if(source.parentElement?.inert)return;
      roleAnchor.current=readRoleAnchor(source);
      restoreRoleAnchor(target,roleAnchor.current,expectedRoleScroll.current);
    };
    const onExpanded=()=>sync(expanded,compact);
    const onCompact=()=>sync(compact,expanded);
    expanded.addEventListener('scroll',onExpanded,{passive:true});
    compact.addEventListener('scroll',onCompact,{passive:true});
    return()=>{
      expanded.removeEventListener('scroll',onExpanded);
      compact.removeEventListener('scroll',onCompact);
    };
  },[worldId]);

  useLayoutEffect(()=>{
    const visible=compactVisible?compactRoles.current:overviewRoleVisible?overviewRoles.current:null;
    if(!visible)return;
    restoreRoleAnchor(visible,roleAnchor.current,expectedRoleScroll.current);
    if(pendingRoleFocus.current!==null){
      if(document.activeElement===overviewToggle.current){
        visible.querySelector<HTMLButtonElement>('[data-role-index="'+pendingRoleFocus.current.index+'"][data-role-action="'+pendingRoleFocus.current.action+'"]')?.focus({preventScroll:true});
      }
      pendingRoleFocus.current=null;
    }
  },[compactVisible,overviewRoleVisible]);

  useLayoutEffect(()=>{
    content.current?.scrollTo({top:0,behavior:'instant'});
  },[section,worldId]);

  const scrollOverview=(collapsed:boolean)=>{
    if(!collapsed){bottomCollapseRequested.current=false;downwardIntentUntil.current=0;}
    animateOverview.current(collapsed);
  };
  const chooseSection=(next:Section,button:HTMLButtonElement)=>{
    bottomCollapseRequested.current=false;
    downwardIntentUntil.current=0;
    const params=new URLSearchParams(query);params.set('tab',sections.find(item=>item.name===next)!.tab);setQuery(params,{replace:true});
    content.current?.scrollTo({top:0,behavior:'instant'});
    scrollOverview(true);
    // Reveal the active chapter in the narrow horizontal tab strip, without scrolling the page.
    const strip=button.parentElement;
    if(strip&&strip.scrollWidth>strip.clientWidth){
      const item=button.getBoundingClientRect(),bounds=strip.getBoundingClientRect();
      if(item.left<bounds.left)strip.scrollLeft+=item.left-bounds.left;
      else if(item.right>bounds.right)strip.scrollLeft+=item.right-bounds.right;
    }
  };
  const collapseAtContentEnd=(pane:HTMLElement)=>{
    if(content.current!==pane||bottomCollapseRequested.current||Date.now()>downwardIntentUntil.current)return;
    if(pane.scrollHeight-pane.clientHeight-pane.scrollTop<=2){
      bottomCollapseRequested.current=true;
      animateOverview.current(true);
    }
  };
  const contentWheel=(event:ReactWheelEvent<HTMLElement>)=>{
    if(event.ctrlKey||event.metaKey||Math.abs(event.deltaY)<=Math.abs(event.deltaX)||event.deltaY===0)return;
    if(event.deltaY<0){downwardIntentUntil.current=0;return;}
    downwardIntentUntil.current=Date.now()+500;
    const pane=event.currentTarget;
    requestAnimationFrame(()=>collapseAtContentEnd(pane));
  };
  const contentScroll=(event:UIEvent<HTMLElement>)=>collapseAtContentEnd(event.currentTarget);
  const contentTouchStart=(event:ReactTouchEvent<HTMLElement>)=>{touchY.current=event.touches[0]?.clientY??null;downwardIntentUntil.current=0;};
  const contentTouchMove=(event:ReactTouchEvent<HTMLElement>)=>{
    const current=event.touches[0]?.clientY;
    if(current===undefined||touchY.current===null)return;
    if(current<touchY.current-2){
      downwardIntentUntil.current=Date.now()+700;
      const pane=event.currentTarget;
      requestAnimationFrame(()=>collapseAtContentEnd(pane));
    }else if(current>touchY.current+2)downwardIntentUntil.current=0;
    touchY.current=current;
  };
  const scrollContentWithKeyboard=(event:KeyboardEvent<HTMLElement>)=>{
    // Keyboard scrolling belongs to the focused reading pane, including its
    // boundaries and short chapters. Never let Home/PageUp expand the overview.
    if(event.target!==event.currentTarget||event.altKey||event.ctrlKey||event.metaKey)return;
    const pane=event.currentTarget;
    const step=Math.max(40,pane.clientHeight*.85);
    const positions:Record<string,number>={
      Home:0,End:pane.scrollHeight,PageUp:pane.scrollTop-step,PageDown:pane.scrollTop+step,
      ArrowUp:pane.scrollTop-40,ArrowDown:pane.scrollTop+40,' ':pane.scrollTop+(event.shiftKey?-step:step)
    };
    if(!(event.key in positions)||event.shiftKey&&event.key!==' ')return;
    event.preventDefault();
    const downward=positions[event.key]>pane.scrollTop;
    downwardIntentUntil.current=downward?Date.now()+500:0;
    pane.scrollTo({top:positions[event.key],behavior:'instant'});
    if(downward)requestAnimationFrame(()=>collapseAtContentEnd(pane));
  };

  const layoutStyle={
    '--collapse-progress':progress,
    '--overview-role-opacity':overviewRoleOpacity,
    '--compact-role-opacity':compactRoleOpacity,
    '--metadata-opacity':reducedMotion?(progress<.5?1:0):1-clamp(progress/.35)
  } as CSSProperties;
  return <div ref={page} className={styles.page} style={layoutStyle} data-collapse-progress={progress}>
    <div ref={viewport} className={styles.viewport} data-world-viewport>
      <section className={styles.overview} aria-label={t('worldOverview')} data-world-overview>
        <div className={styles.overviewToolbar}>
          <button ref={overviewToggle} className={styles.overviewToggle} onClick={()=>scrollOverview(!isCompact)} aria-label={isCompact?t('expandWorldOverview'):t('collapseWorldOverview')} title={isCompact?t('expandWorldOverview'):t('collapseWorldOverview')} aria-expanded={!isCompact}>
            {isCompact?<ChevronDown size={17}/>:<ChevronUp size={17}/>}
          </button>
        </div>
        <div className={styles.worldActionsSlot}><WorldActions world={world} onSaved={onSaved}/></div>
        <div className={styles.overviewTop}>
          {safeImage(world.cover,assetBaseUrl)?<img key={contentKey} className={styles.cover} src={safeImage(world.cover,assetBaseUrl)} alt=""/>:<div className={styles.cover} aria-hidden="true"/>}
          <div className={styles.worldText}>
            <h1 title={world.name}>{world.name}</h1>
            <div className={styles.metadata} aria-hidden={reducedMotion?progress>=.5:progress>=.35}>
              <div className={styles.publicationRow}><WorldPublication world={world} onSummary={onSummary} onApplied={onSaved}/></div>
              <div className={styles.tags}>{world.tags?.map(c=><span key={c}>{c}</span>)}<span className={styles.worldFacts}>{t('worlds:characterCount',{count:names.length})}</span></div>
            </div>
          </div>
        </div>
        <div className={styles.overviewRoles} inert={!overviewRoleVisible} aria-hidden={!overviewRoleVisible}>
          <RoleStrip characters={world.characters} compact={false} active={selectedRole} onChoose={setSelectedRole} onInspect={setRoleDialog} stripRef={overviewRoles} contentKey={contentKey}/>
        </div>
        <div className={styles.compactRoles} aria-label={t('worldContentNavigation')} inert={!compactVisible} aria-hidden={!compactVisible}>
          <RoleStrip characters={world.characters} compact active={selectedRole} onChoose={setSelectedRole} onInspect={setRoleDialog} stripRef={compactRoles} contentKey={contentKey}/>
        </div>
      </section>
      <div className={styles.workspace} data-world-workspace>
        <nav className={styles.tabs} aria-label={t('worldSections')}>
          {sections.map(({name,icon:Icon})=><button key={name} data-world-section={name} className={[styles.tab,section===name?styles.tabActive:''].join(' ')} onClick={event=>chooseSection(name,event.currentTarget)} aria-current={section===name?'page':undefined}><Icon size={17} strokeWidth={1.8}/><span>{t('worlds:tab.'+name)}</span></button>)}
        </nav>
        <article ref={content} className={styles.content} data-world-content tabIndex={0} aria-label={t('worlds:sectionDetails',{name:t('worlds:tab.'+section)})} onKeyDown={scrollContentWithKeyboard} onWheel={contentWheel} onScroll={contentScroll} onTouchStart={contentTouchStart} onTouchMove={contentTouchMove}>
          <div className={styles.contentInner} data-full-width={section==='sessions'}><WorldDetailContent section={section} world={world} onSaved={onSaved} characterId={world.characters[selectedRole]?.id}/></div>
        </article>
      </div>
    </div>
    {roleDialog!==null&&world.characters[roleDialog]&&<Modal title={world.characters[roleDialog].name} onClose={()=>setRoleDialog(null)}>{world.characters[roleDialog].description?<WorldDocumentRenderer showStyleWarning={false} title={t('characterIntroduction2')} content={world.characters[roleDialog].description!}/>:<p>{t('thisCharacterHasNoIntroductionYet')}</p>}</Modal>}
  </div>;
}
