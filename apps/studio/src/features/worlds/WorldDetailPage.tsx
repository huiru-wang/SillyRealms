import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {ArrowLeft,BookOpen,BookText,ChevronRight,Compass,Settings2,ScrollText,SlidersHorizontal,Users} from 'lucide-react';
import {worlds} from '../../fixtures/worlds';
import styles from './WorldDetailPage.module.css';

type Section = '介绍'|'世界书'|'世界状态'|'开局'|'运行配置';
const sections:{name:Section;icon:typeof BookOpen}[]=[
  {name:'介绍',icon:BookOpen},{name:'世界书',icon:BookText},{name:'世界状态',icon:SlidersHorizontal},
  {name:'开局',icon:Compass},{name:'运行配置',icon:Settings2}
];
const names=['罗斯','凯莉','Robin','詹姆斯','清月','安娜','林恩','艾琳','查理','伊莎贝拉'];
const description='一座繁华而神秘的城市，传统与未知交错。每个人都拥有自己的秘密与愿望，随你的选择，关系和故事将沿着不同的轨迹展开。在这里，任何相遇都可能成为一段新的传奇。';

function RoleStrip({compact,active,onChoose,stripRef}:{compact:boolean;active:number;onChoose:(i:number)=>void;stripRef:React.RefObject<HTMLDivElement|null>}){
  return <div className={[styles.roleStrip,compact?styles.roleStripCompact:''].join(' ')} ref={stripRef} role="group" aria-label="世界角色列表" data-role-strip={compact?'compact':'expanded'}>
    {names.map((name,i)=><button key={name} className={[styles.role,active===i?styles.roleActive:''].join(' ')} title={name} aria-pressed={active===i} onClick={()=>onChoose(i)}>
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
  const {worldId}=useParams();const world=worlds.find(w=>w.id===worldId);
  const [selectedRole,setSelectedRole]=useState(2);
  const [section,setSection]=useState<Section>('介绍');
  const [compactVisible,setCompactVisible]=useState(false);
  const [overviewRoleVisible,setOverviewRoleVisible]=useState(true);
  const overviewRoles=useRef<HTMLDivElement>(null);
  const compactRoles=useRef<HTMLDivElement>(null);
  const compactHeader=useRef<HTMLElement>(null);
  const overview=useRef<HTMLElement>(null);
  const scrollSync=useRef(false);
  useEffect(()=>{
    const main=document.getElementById('main-content');if(!main)return;
    main.scrollTop=0;
    let frame=0;
    const update=()=>{
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(()=>{
        const headerY=compactHeader.current?.getBoundingClientRect().top??9999;
        const viewportY=main.getBoundingClientRect().top;
        const roleY=overviewRoles.current?.getBoundingClientRect().bottom??9999;
        const showHeader=headerY<=viewportY+62;
        setCompactVisible(showHeader);
        setOverviewRoleVisible(roleY>viewportY+108);
      });
    };
    main.addEventListener('scroll',update,{passive:true});window.addEventListener('resize',update);update();
    return()=>{main.removeEventListener('scroll',update);window.removeEventListener('resize',update);cancelAnimationFrame(frame)};
  },[worldId]);
  useLayoutEffect(()=>{
    const a=overviewRoles.current,b=compactRoles.current;if(!a||!b)return;
    const onA=()=>{if(scrollSync.current)return;scrollSync.current=true;b.scrollLeft=a.scrollLeft;scrollSync.current=false};
    const onB=()=>{if(scrollSync.current)return;scrollSync.current=true;a.scrollLeft=b.scrollLeft;scrollSync.current=false};
    a.addEventListener('scroll',onA,{passive:true});b.addEventListener('scroll',onB,{passive:true});
    return()=>{a.removeEventListener('scroll',onA);b.removeEventListener('scroll',onB)};
  },[worldId]);
  if(!world)return <div className={styles.notFound}><h1>未找到世界卡</h1><Link to="/worlds">返回世界卡</Link></div>;
  return <div className={styles.page}>
    <section ref={overview} className={styles.overview} aria-label="世界概览">
      <Link className={styles.back} to="/worlds"><ArrowLeft size={16}/>世界卡</Link>
      <div className={styles.overviewTop}>
        <img className={styles.cover} src={world.cover} alt=""/>
        <div className={styles.worldText}>
          <div className={styles.overline}>WORLD PROFILE <span> / {world.genre}</span></div>
          <h1>{world.title}</h1>
          <p>{world.description} {description}</p>
          <div className={styles.tags}>{world.categories.map(c=><span key={c}>{c}</span>)}<span>{world.genre}</span></div>
          <div className={styles.worldFacts}><span><Users size={15}/> {names.length} 位角色</span><span><ScrollText size={15}/> {world.sessionCount} 个会话</span></div>
        </div>
      </div>
      <div className={[styles.overviewRoles,!overviewRoleVisible?styles.rolesGone:''].join(' ')}>
        <div className={styles.roleHeading}><h2>世界角色</h2><span>选择角色，探索不同的故事视角</span></div>
        <RoleStrip compact={false} active={selectedRole} onChoose={setSelectedRole} stripRef={overviewRoles}/>
      </div>
    </section>
    <header ref={compactHeader} className={[styles.compactHeader,compactVisible?styles.compactShown:''].join(' ')} aria-label="世界内容导航">
      <div className={styles.compactIdentity}><img src={world.cover} alt=""/><span title={world.title}>{world.title}</span></div>
      <div className={styles.compactRoles} inert={!compactVisible} aria-hidden={!compactVisible}>
        <RoleStrip compact active={selectedRole} onChoose={setSelectedRole} stripRef={compactRoles}/>
      </div>
    </header>
    <div className={styles.workspace}>
      <nav className={styles.tabs} aria-label="世界详情章节">
        {sections.map(({name,icon:Icon})=><button key={name} className={[styles.tab,section===name?styles.tabActive:''].join(' ')} onClick={()=>setSection(name)} aria-current={section===name?'page':undefined}><Icon size={17} strokeWidth={1.8}/><span>{name}</span></button>)}
      </nav>
      <article className={styles.content} key={section}><SectionContent section={section} worldTitle={world.title}/></article>
    </div>
  </div>;
}
