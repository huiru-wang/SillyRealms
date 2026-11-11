import {useLayoutEffect,useRef,useState,type CSSProperties,type KeyboardEvent,type RefObject} from 'react';
import {Link,useParams} from 'react-router-dom';
import {ArrowLeft,BookOpen,BookText,ChevronDown,ChevronRight,ChevronUp,Compass,Settings2,SlidersHorizontal} from 'lucide-react';
import {worlds} from '../../fixtures/worlds';
import styles from './WorldDetailPage.module.css';

type Section = '介绍'|'世界书'|'世界状态'|'开局'|'运行配置';
const sections:{name:Section;icon:typeof BookOpen}[]=[
  {name:'介绍',icon:BookOpen},{name:'世界书',icon:BookText},{name:'世界状态',icon:SlidersHorizontal},
  {name:'开局',icon:Compass},{name:'运行配置',icon:Settings2}
];
const names=['罗斯','凯莉','Robin','詹姆斯','清月','安娜','林恩','艾琳','查理','伊莎贝拉'];
const description='一座繁华而神秘的城市，传统与未知交错。每个人都拥有自己的秘密与愿望，随你的选择，关系和故事将沿着不同的轨迹展开。在这里，任何相遇都可能成为一段新的传奇。';

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
function RoleStrip({compact,active,onChoose,stripRef}:{compact:boolean;active:number;onChoose:(i:number)=>void;stripRef:RefObject<HTMLDivElement|null>}){
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
    {names.map((name,i)=><button key={name} data-role-index={i} className={[styles.role,active===i?styles.roleActive:''].join(' ')} title={name} aria-pressed={active===i} onClick={()=>onChoose(i)}>
      <span className={styles.roleAvatar} aria-hidden="true"><span>{name.slice(0,1)}</span></span>
      <span className={styles.roleName}>{name}</span>
    </button>)}
  </div>;
}
function SectionContent({section,worldTitle}:{section:Section;worldTitle:string}){
  if(section==='世界书')return <><div className={styles.contentEyebrow}>LORE & KNOWLEDGE</div><h2>世界书</h2><p className={styles.lead}>世界运行的规则、历史与背景，在这里汇集。</p>{['城市与时代','组织与势力','约定与禁忌','重要地点'].map((title,i)=><article className={styles.entry} key={title}><span className={styles.entryNumber}>0{i+1}</span><div><h3>{title}</h3><p>{['繁华与隐秘在街巷间共存，过去留下的痕迹仍影响着当下。','各方势力在明处与暗处保持着微妙的平衡。','这里有一些不成文的规则，也有等待被打破的传统。','从喧闹的集市到静谧的庭院，每处都藏有自己的故事。'][i]}</p></div><ChevronRight size={17}/></article>)}</>;
  if(section==='世界状态')return <><div className={styles.contentEyebrow}>WORLD STATE</div><h2>世界状态</h2><p className={styles.lead}>当前世界的共享状态与环境信息。以下为静态原型数据。</p><div className={styles.stateGrid}>{[['时间','仲夏 · 黄昏'],['天气','薄云，微风'],['地点','城中主街'],['故事阶段','初章'],['城市氛围','平静'],['当前事件','庆典前夕']].map(([k,v])=><div className={styles.stateCell} key={k}><span>{k}</span><strong>{v}</strong></div>)}</div></>;
  if(section==='开局')return <><div className={styles.contentEyebrow}>OPENINGS</div><h2>故事开局</h2><p className={styles.lead}>从不同的起点进入同一个世界。</p>{['初入城中','雨夜相逢','未寄出的信'].map((s,i)=><article className={styles.opening} key={s}><span>0{i+1}</span><div><h3>{s}</h3><p>{['黄昏时分，你第一次踏进这座城，远处传来悠长的钟声。','一场突如其来的雨，把两个陌生人带到了同一处屋檐下。','一封没有署名的信笺，意外改变了平静的一天。'][i]}</p></div></article>)}</>;
  if(section==='运行配置')return <><div className={styles.contentEyebrow}>RUNTIME</div><h2>运行配置</h2><p className={styles.lead}>管理这个世界的叙事体验与默认运行选项。</p>{[['默认预设','通用叙事'],['叙事视角','第三人称'],['状态更新','已启用'],['角色选择','允许自由切换']].map(([label,value])=><div className={styles.setting} key={label}><span>{label}</span><strong>{value}</strong></div>)}</>;
  return <><div className={styles.contentEyebrow}>ABOUT THIS WORLD</div><h2>世界介绍</h2><p className={styles.lead}>{worldTitle}，是一个等待你亲自探索的故事世界。</p><div className={styles.rule}/><h3>故事背景</h3><p>{description}</p><p>故事并不围绕唯一的主角展开。你可以从不同人物的视角出发，见证同一事件如何改变不同人的命运。角色之间的关系也会随着每次选择发生微妙变化。</p><h3>在这里，你可以</h3><p>与形形色色的人物相识、探索尚未揭开的秘密，也可以放慢脚步，感受这个世界的日常。每一个决定都是故事的一部分。</p><div className={styles.quote}>「故事从来没有唯一的答案，只有走过之后，才知道自己选择了哪条路。」</div><h3>世界设定</h3><p>人物拥有各自的立场与动机。世界的时间与环境会推进，事件之间也可能产生联系。不同的开局提供不同的切入点，而世界本身保持统一。</p><p>{description}</p></>;
}

export function WorldDetailPage(){
  const {worldId}=useParams();
  const world=worlds.find(w=>w.id===worldId);
  const [selectedRole,setSelectedRole]=useState(2);
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
    let frame=0,lastProgress=0;
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
    const motionChanged=()=>{setReducedMotion(motion.matches);queueUpdate();};
    main.scrollTo({top:0,behavior:'instant'});
    setProgress(0);
    setSelectedRole(2);
    setSection('介绍');
    roleAnchor.current={index:0,fraction:0};
    pendingRoleFocus.current=null;
    measure();
    motionChanged();
    const observer=new ResizeObserver(measure);
    observer.observe(stage);
    main.addEventListener('scroll',queueUpdate,{passive:true});
    motion.addEventListener('change',motionChanged);
    return()=>{
      observer.disconnect();
      main.removeEventListener('scroll',queueUpdate);
      motion.removeEventListener('change',motionChanged);
      cancelAnimationFrame(frame);
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
    document.getElementById('main-content')?.scrollTo({
      top:collapsed?collapseRange.current:0,
      behavior:reducedMotion?'instant':'smooth'
    });
  };
  const chooseSection=(next:Section)=>{
    setSection(next);
    content.current?.scrollTo({top:0,behavior:'instant'});
    scrollOverview(true);
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
    pane.scrollTo({top:positions[event.key],behavior:'instant'});
  };

  if(!world)return <div className={styles.notFound}><h1>未找到世界卡</h1><Link to="/worlds">返回世界卡</Link></div>;
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
          <Link className={styles.back} to="/worlds" aria-label="返回世界卡列表"><ArrowLeft size={17}/><span>世界卡</span></Link>
          <button ref={overviewToggle} className={styles.overviewToggle} onClick={()=>scrollOverview(!isCompact)} aria-label={isCompact?'展开世界概览':'收起世界概览'} title={isCompact?'展开世界概览':'收起世界概览'} aria-expanded={!isCompact}>
            {isCompact?<ChevronDown size={17}/>:<ChevronUp size={17}/>}
          </button>
        </div>
        <div className={styles.overviewTop}>
          <img className={styles.cover} src={world.cover} alt=""/>
          <div className={styles.worldText}>
            <h1 title={world.title}>{world.title}</h1>
            <div className={styles.summary} aria-hidden={reducedMotion?progress>=.5:progress>=.35}>
              <p>{world.description} {description}</p>
              <div className={styles.tags}>{world.categories.map(c=><span key={c}>{c}</span>)}<span>{world.genre}</span><span className={styles.worldFacts}>{names.length} 位角色 · {world.sessionCount} 个会话</span></div>
            </div>
          </div>
        </div>
        <div className={styles.overviewRoles} inert={!overviewRoleVisible} aria-hidden={!overviewRoleVisible}>
          <div className={styles.roleHeading}><h2>世界角色</h2><span>选择角色，探索不同的故事视角</span></div>
          <RoleStrip compact={false} active={selectedRole} onChoose={setSelectedRole} stripRef={overviewRoles}/>
        </div>
        <div className={styles.compactRoles} aria-label="世界内容导航" inert={!compactVisible} aria-hidden={!compactVisible}>
          <RoleStrip compact active={selectedRole} onChoose={setSelectedRole} stripRef={compactRoles}/>
        </div>
      </section>
      <div className={styles.workspace} data-world-workspace>
        <nav className={styles.tabs} aria-label="世界详情章节">
          {sections.map(({name,icon:Icon})=><button key={name} className={[styles.tab,section===name?styles.tabActive:''].join(' ')} onClick={()=>chooseSection(name)} aria-current={section===name?'page':undefined}><Icon size={17} strokeWidth={1.8}/><span>{name}</span></button>)}
        </nav>
        <article ref={content} className={styles.content} data-world-content tabIndex={0} aria-label={section+'详情'} onKeyDown={scrollContentWithKeyboard}>
          <div className={styles.contentInner}><SectionContent section={section} worldTitle={world.title}/></div>
        </article>
      </div>
    </div>
  </div>;
}
