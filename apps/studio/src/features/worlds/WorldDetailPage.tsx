import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type KeyboardEvent,type RefObject,type TouchEvent as ReactTouchEvent,type UIEvent,type WheelEvent as ReactWheelEvent} from 'react';
import {Link,useParams} from 'react-router-dom';
import {BookOpen,BookText,ChevronDown,ChevronRight,ChevronUp,Compass,Ellipsis,MessageCircle,Settings2,SlidersHorizontal} from 'lucide-react';
import {WorldDocumentRenderer} from '@sillyrealms/sdk';
import {Modal} from '../../components/ui/Modal';
import {getWorld,listSessions,safeImage,type WorldDetail} from './api/worlds';
import {usePaged} from './api/usePaged';
import {StateItems,WorldState} from './StateInspector';
import styles from './WorldDetailPage.module.css';

type Section = '介绍'|'世界书'|'世界状态'|'开局'|'运行配置'|'会话';
const sections:{name:Section;icon:typeof BookOpen}[]=[
  {name:'介绍',icon:BookOpen},{name:'世界书',icon:BookText},{name:'世界状态',icon:SlidersHorizontal},
  {name:'开局',icon:Compass},{name:'会话',icon:MessageCircle},{name:'运行配置',icon:Settings2}
];

type RoleAnchor = {index:number;fraction:number};
const clamp=(value:number,min=0,max=1)=>Math.min(max,Math.max(min,value));
const expandedOpacity=(progress:number)=>1-clamp((progress-.08)/.32);
const compactOpacity=(progress:number)=>clamp((progress-.6)/.3);

// Keep the visible character, rather than the pixel offset, across two densities.
function rolePositions(strip:HTMLDivElement){
  const left=strip.getBoundingClientRect().left;
  return Array.from(strip.querySelectorAll<HTMLButtonElement>('button')).map(button=>({
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
function RoleStrip({names,avatars,compact,active,onChoose,stripRef}:{names:readonly string[];avatars:readonly (string|undefined)[];compact:boolean;active:number;onChoose:(i:number)=>void;stripRef:RefObject<HTMLDivElement|null>}){
  const navigateRoles=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.altKey||event.ctrlKey||event.metaKey)return;
    const keys=['ArrowLeft','ArrowRight','Home','End'];
    if(!keys.includes(event.key))return;
    const strip=event.currentTarget;
    const buttons=Array.from(strip.querySelectorAll<HTMLButtonElement>('button'));
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
  return <div className={[styles.roleStrip,compact?styles.roleStripCompact:''].join(' ')} ref={stripRef} role="group" aria-label="世界角色列表" data-role-strip={compact?'compact':'expanded'} onKeyDown={navigateRoles}>
    {names.map((name,i)=><button key={i} data-role-index={i} className={[styles.role,active===i?styles.roleActive:''].join(' ')} title={name} aria-pressed={active===i} onClick={()=>onChoose(i)}>
      <span className={styles.roleAvatar} aria-hidden="true">{safeImage(avatars[i])?<img src={safeImage(avatars[i])} alt=""/>:<span>{name.slice(0,1)}</span>}</span>
      <span className={styles.roleName}>{name}</span>
    </button>)}
  </div>;
}
function SessionSection({worldId}:{worldId:string}){
  const {page,loading,error,more,retry}=usePaged(worldId,(cursor,signal)=>listSessions(worldId,cursor,signal));
  const [menu,setMenu]=useState<string|null>(null);
  return <>
    {loading&&!page&&<p role="status">正在加载会话…</p>}
    {error&&<div role="alert" className={styles.emptySessions}><strong>无法加载会话</strong><button onClick={retry}>重试</button></div>}
    {page&&page.items.length>0&&<div className={styles.sessionList}>{page.items.map(session=><div key={session.id} className={styles.sessionLink}>
      <span><strong>{session.title||'未命名会话'}</strong><small>更新于 {new Date(session.updatedAt).toLocaleDateString()}</small></span><div className={styles.sessionActions} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setMenu(null);}} onKeyDown={event=>{if(event.key==='Escape')setMenu(null);}}><button className={styles.moreButton} aria-label={(session.title||'未命名会话')+'的更多操作'} aria-expanded={menu===session.id} onClick={()=>setMenu(menu===session.id?null:session.id)}><Ellipsis size={20}/></button>{menu===session.id&&<div className={styles.moreMenu} role="status">暂无可用操作</div>}</div>
    </div>)}</div>}
    {!loading&&!error&&page?.items.length===0&&<div className={styles.emptySessions}><MessageCircle size={22} aria-hidden="true"/><strong>还没有会话</strong><p>在这个世界开始的故事会显示在这里。</p></div>}
    {page?.hasMore&&!error&&<button className={styles.actionButton} disabled={loading} onClick={more}>{loading?'加载中…':'加载更多'}</button>}
  </>;
}
function SectionContent({section,world}:{section:Section;world:WorldDetail}){
  const [openingIndex,setOpeningIndex]=useState(0);
  const [stateOpen,setStateOpen]=useState(false);
  const [expandedLore,setExpandedLore]=useState<Set<string>>(new Set());
  const data=world.data,opening=data.openings[openingIndex];
  const touch=useRef<number|null>(null);
  const frameCleanup=useRef<(()=>void)|null>(null);
  useEffect(()=>()=>frameCleanup.current?.(),[]);
  const finishSwipe=(end:number|undefined)=>{
    if(end!==undefined&&touch.current!==null&&Math.abs(end-touch.current)>50)setOpeningIndex(i=>Math.max(0,Math.min(data.openings.length-1,i+(end<touch.current!?1:-1))));
    touch.current=null;
  };
  if(section==='会话')return <SessionSection worldId={world.id}/>;
  if(section==='世界书')return data.lorebook?.entries.length?<div className={styles.loreList}>{data.lorebook.entries.map(entry=><section key={entry.id} className={styles.loreItem}><button className={styles.loreToggle} aria-expanded={expandedLore.has(entry.id)} onClick={()=>setExpandedLore(previous=>{const next=new Set(previous);next.has(entry.id)?next.delete(entry.id):next.add(entry.id);return next;})}><span>{entry.title||'未命名条目'}</span><ChevronRight size={17} className={expandedLore.has(entry.id)?styles.loreChevronOpen:''}/></button>{expandedLore.has(entry.id)&&<div className={styles.loreContent}><WorldDocumentRenderer title={entry.title||'世界书条目'} content={entry.content}/></div>}</section>)}</div>:<p>这个世界还没有世界书条目。</p>;
  if(section==='世界状态')return <WorldState scopes={data.state?.scopes??{}}/>;
  if(section==='开局')return opening?<><div onTouchStart={event=>{touch.current=event.touches[0]?.clientX??null;}} onTouchEnd={event=>finishSwipe(event.changedTouches[0]?.clientX)} onLoadCapture={event=>{
    if(!(event.target instanceof HTMLIFrameElement))return;
    frameCleanup.current?.();const doc=event.target.contentDocument;if(!doc)return;
    const start=(e:TouchEvent)=>{touch.current=e.touches[0]?.clientX??null;};
    const end=(e:TouchEvent)=>finishSwipe(e.changedTouches[0]?.clientX);
    doc.addEventListener('touchstart',start,{passive:true});doc.addEventListener('touchend',end,{passive:true});
    frameCleanup.current=()=>{doc.removeEventListener('touchstart',start);doc.removeEventListener('touchend',end);};
  }}>
    <div className={styles.openingToolbar}><div className={styles.openingNav}><button className={styles.actionButton} disabled={openingIndex===0} onClick={()=>setOpeningIndex(i=>i-1)} aria-label="上一个开局">‹</button><span>{openingIndex+1} / {data.openings.length}</span><button className={styles.actionButton} disabled={openingIndex===data.openings.length-1} onClick={()=>setOpeningIndex(i=>i+1)} aria-label="下一个开局">›</button></div><button className={styles.stateButton} onClick={()=>setStateOpen(true)}>查看初始状态</button></div>
    <h3>{opening.name}</h3><WorldDocumentRenderer title={opening.name} content={opening.content}/>
  </div>{stateOpen&&<Modal title="开局初始状态" size="editor" onClose={()=>setStateOpen(false)}><p className={styles.stateIntro}>“{opening.name}”开始时的消息状态，仅供查看。</p>{Object.keys(data.state?.scopes?.message??{}).length?<StateItems items={data.state?.scopes?.message??{}} overrides={opening.initial_state??{}}/>:<p>这个世界没有声明消息状态。</p>}</Modal>}</>:<p>这个世界没有开局。</p>;
  if(section==='运行配置')return <><div className={styles.setting}><span>默认预设</span><strong>{world.defaultPresetId?'已设置':'未设置'}</strong></div><div className={styles.setting}><span>默认模型</span><strong>{world.defaultApiModelConfigId?'已设置':'未设置'}</strong></div></>;
  return data.description?<WorldDocumentRenderer title="世界介绍" content={data.description}/>:<p>{data.summary||'这个世界还没有介绍。'}</p>;
}

export function WorldDetailPage(){
  const {worldId}=useParams();
  const [world,setWorld]=useState<WorldDetail|null>(null);
  const [error,setError]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{const c=new AbortController();setWorld(null);setError(false);if(worldId)getWorld(worldId,c.signal).then(result=>setWorld(result.item)).catch(()=>{if(!c.signal.aborted)setError(true);});else setError(true);return()=>c.abort();},[worldId,revision]);
  if(!world||world.id!==worldId)return <div className={styles.notFound}>{error?<><h1>无法加载世界卡</h1><p>世界卡可能不存在，或服务暂时不可用。</p><button className={styles.actionButton} onClick={()=>setRevision(n=>n+1)}>重试</button> <Link to="/worlds">返回世界卡</Link></>:<p role="status">正在加载世界卡…</p>}</div>;
  return <WorldDetailView key={world.id} world={world}/>;
}
function WorldDetailView({world}:{world:WorldDetail}){
  const worldId=world.id;
  const names=world.data.characters.map(character=>character.name);
  const avatars=world.data.characters.map(character=>character.avatar);
  const [roleDialog,setRoleDialog]=useState<number|null>(null);
  const [selectedRole,setSelectedRole]=useState(-1);
  const [section,setSection]=useState<Section>('介绍');
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
  const pendingRoleFocus=useRef<number|null>(null);
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
        pendingRoleFocus.current=Number(active.dataset.roleIndex);
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
    const motionChanged=()=>{setReducedMotion(motion.matches);queueUpdate();};
    main.scrollTo({top:0,behavior:'instant'});
    setProgress(0);
    setSelectedRole(-1);
    setSection('介绍');
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
        visible.querySelector<HTMLButtonElement>('[data-role-index="'+pendingRoleFocus.current+'"]')?.focus({preventScroll:true});
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
  const chooseSection=(next:Section)=>{
    bottomCollapseRequested.current=false;
    downwardIntentUntil.current=0;
    setSection(next);
    content.current?.scrollTo({top:0,behavior:'instant'});
    scrollOverview(true);
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
    '--summary-opacity':reducedMotion?(progress<.5?1:0):1-clamp(progress/.35)
  } as CSSProperties;
  return <div ref={page} className={styles.page} style={layoutStyle} data-collapse-progress={progress}>
    <div ref={viewport} className={styles.viewport} data-world-viewport>
      <section className={styles.overview} aria-label="世界概览" data-world-overview>
        <div className={styles.overviewToolbar}>
          <button ref={overviewToggle} className={styles.overviewToggle} onClick={()=>scrollOverview(!isCompact)} aria-label={isCompact?'展开世界概览':'收起世界概览'} title={isCompact?'展开世界概览':'收起世界概览'} aria-expanded={!isCompact}>
            {isCompact?<ChevronDown size={17}/>:<ChevronUp size={17}/>}
          </button>
        </div>
        <div className={styles.overviewTop}>
          {safeImage(world.data.cover)?<img className={styles.cover} src={safeImage(world.data.cover)} alt=""/>:<div className={styles.cover} aria-hidden="true"/>}
          <div className={styles.worldText}>
            <h1 title={world.data.name}>{world.data.name}</h1>
            <div className={styles.summary} aria-hidden={reducedMotion?progress>=.5:progress>=.35}>
              <p>{world.data.summary||''}</p>
              <div className={styles.tags}>{world.data.tags?.map(c=><span key={c}>{c}</span>)}<span className={styles.worldFacts}>{names.length} 位角色</span></div>
            </div>
          </div>
        </div>
        <div className={styles.overviewRoles} inert={!overviewRoleVisible} aria-hidden={!overviewRoleVisible}>
          <RoleStrip names={names} avatars={avatars} compact={false} active={selectedRole} onChoose={i=>{setSelectedRole(i);setRoleDialog(i);}} stripRef={overviewRoles}/>
        </div>
        <div className={styles.compactRoles} aria-label="世界内容导航" inert={!compactVisible} aria-hidden={!compactVisible}>
          <RoleStrip names={names} avatars={avatars} compact active={selectedRole} onChoose={i=>{setSelectedRole(i);setRoleDialog(i);}} stripRef={compactRoles}/>
        </div>
      </section>
      <div className={styles.workspace} data-world-workspace>
        <nav className={styles.tabs} aria-label="世界详情章节">
          {sections.map(({name,icon:Icon})=><button key={name} data-world-section={name} className={[styles.tab,section===name?styles.tabActive:''].join(' ')} onClick={()=>chooseSection(name)} aria-current={section===name?'page':undefined}><Icon size={17} strokeWidth={1.8}/><span>{name}</span></button>)}
        </nav>
        <article ref={content} className={styles.content} data-world-content tabIndex={0} aria-label={section+'详情'} onKeyDown={scrollContentWithKeyboard} onWheel={contentWheel} onScroll={contentScroll} onTouchStart={contentTouchStart} onTouchMove={contentTouchMove}>
          <div className={styles.contentInner}><SectionContent key={section} section={section} world={world}/></div>
        </article>
      </div>
    </div>
    {roleDialog!==null&&world.data.characters[roleDialog]&&<Modal title={world.data.characters[roleDialog].name} onClose={()=>setRoleDialog(null)}>{world.data.characters[roleDialog].description?<WorldDocumentRenderer title="角色介绍" content={world.data.characters[roleDialog].description!}/>:<p>该角色暂无介绍。</p>}</Modal>}
  </div>;
}
