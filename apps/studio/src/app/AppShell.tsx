import {useEffect,useState} from 'react';
import {Link,NavLink,Outlet,useLocation,useMatch,useNavigate} from 'react-router-dom';
import {BookOpen,Box,Layers3,Menu,MessageCircle,PanelLeftClose,PanelLeftOpen,Settings,X} from 'lucide-react';
import {useLoad} from './ui';
import {useTheme} from '../hooks/useTheme';
import {usePresetStore} from '../features/presets/PresetStore';
import styles from './AppShell.module.css';

const NAV=[
  {title:'世界卡',path:'/worlds',Icon:BookOpen}
] as const;
const MOBILE_NAV=[
  {path:'/worlds',label:'世界卡',Icon:BookOpen},
  {path:'/presets',label:'预设',Icon:Layers3},
  {path:'/sessions',label:'会话',Icon:MessageCircle},
  {path:'/models',label:'模型',Icon:Box},
  {path:'/settings',label:'设置',Icon:Settings}
] as const;

function getCollapse(){
  const p=new URLSearchParams(location.search).get('sidebar');
  if(p==='collapsed')return true;
  if(p==='expanded')return false;
  try{return localStorage.getItem('sr-studio-sidebar')==='collapsed';}catch{return false;}
}
export function AppShell(){
  const [collapsed,setCollapsed]=useState(getCollapse);
  const [mobileOpen,setMobileOpen]=useState(false);
  const sessions=useLoad('v1/sessions?limit=2');
  useEffect(()=>{const update=()=>void sessions.reload();window.addEventListener('sr:catalog-changed',update);return()=>window.removeEventListener('sr:catalog-changed',update);},[sessions.reload]);
  const models=useLoad('v1/api-model-configs');
  useEffect(()=>{const update=()=>void models.reload();window.addEventListener('sr:models-changed',update);return()=>window.removeEventListener('sr:models-changed',update);},[models.reload]);
  const modelShortcuts=(models.value?.items??[]).slice(0,2);
  const sessionShortcuts=(sessions.value?.items??[]).slice(0,2);
  const {theme,toggleTheme}=useTheme();

  const nav=useNavigate();
  const location=useLocation();
  const isWorldDetail=Boolean(useMatch('/worlds/:worldId'));
  const showMobileNav=['/worlds','/sessions','/presets','/more','/models','/settings','/setup'].includes(location.pathname.replace(/\/+$/,'')||'/');
  const {presets,defaultPresetId}=usePresetStore();
  const presetShortcuts=[...presets.filter(preset=>preset.id===defaultPresetId),...presets.filter(preset=>preset.id!==defaultPresetId)].slice(0,2);
  const toggleCollapsed=()=>{
    setCollapsed(v=>{const n=!v;try{localStorage.setItem('sr-studio-sidebar',n?'collapsed':'expanded');}catch{}return n;});
  };
  useEffect(()=>setMobileOpen(false),[location.pathname]);

  const labelsHidden=collapsed&&!mobileOpen;
  const sessionPaths=sessionShortcuts.map((item:any)=>'/sessions/'+encodeURIComponent(item.id));
  const sessionSection=location.pathname==='/sessions'||location.pathname.startsWith('/sessions/');
  const presetSection=location.pathname==='/presets'||location.pathname.startsWith('/presets/');
  const sessionShortcutActive=!labelsHidden&&sessionPaths.includes(location.pathname);
  const presetShortcutActive=!labelsHidden&&presetShortcuts.some(preset=>location.pathname==='/presets/'+preset.id);
  const sessionHeadingActive=sessionSection&&!sessionShortcutActive;
  const presetHeadingActive=presetSection&&!presetShortcutActive;
  const modelSection=location.pathname==='/models'||location.pathname.startsWith('/models/');
  const modelShortcutActive=!labelsHidden&&modelShortcuts.some((item:any)=>location.pathname==='/models/'+encodeURIComponent(item.id));
  const modelHeadingActive=modelSection&&!modelShortcutActive;
  return <div className={styles.layout} data-collapsed={collapsed?'true':'false'}>
    <a className={styles.skipLink} href="#main-content">跳转到主要内容</a>
    <button className={styles.mobileOpen} aria-label="打开导航" onClick={()=>setMobileOpen(true)}><Menu size={20}/></button>
    <button className={styles.mobileShade} data-open={mobileOpen} disabled={!mobileOpen} aria-hidden={!mobileOpen} aria-label="关闭导航遮罩" onClick={()=>setMobileOpen(false)}/>
    <aside className={[styles.sidebarWrap,mobileOpen?styles.mobileVisible:''].join(' ')}>
      <div className={styles.sidebar}>
        <div className={styles.brandRow}>
          <button className={styles.brand} title="返回世界卡" aria-label="返回世界卡" onClick={()=>nav('/worlds')}>
            <span className={styles.brandName}>{labelsHidden?'SR':'SillyRealms'}</span>
          </button>
          <button className={styles.mobileClose} aria-label="关闭导航" onClick={()=>setMobileOpen(false)}><X size={19}/></button>
        </div>

        <nav className={styles.primaryNav} aria-label="主导航">
          {NAV.map(({title,path,Icon})=><NavLink key={path} to={path} title={labelsHidden?title:undefined} aria-label={title} className={({isActive})=>[styles.navItem,isActive?styles.navSelected:''].join(' ')}>
            <Icon size={20} strokeWidth={1.8} aria-hidden="true"/>
            <span className={styles.navLabel} aria-hidden={labelsHidden}>{title}</span>
          </NavLink>)}
        </nav>
        <div className={styles.sidebarData}>
          <section className={styles.dataSection} aria-labelledby="sessions-heading">
            <h2 id="sessions-heading" className={styles.sectionTitle}><Link to="/sessions" title={labelsHidden?'会话列表':undefined} aria-label="会话列表" aria-current={sessionHeadingActive?(location.pathname==='/sessions'?'page':'location'):undefined} className={[styles.navItem,sessionHeadingActive?styles.navSelected:''].join(' ')}><MessageCircle size={20} strokeWidth={1.8} aria-hidden="true"/><span className={styles.navLabel} aria-hidden={labelsHidden}>会话列表</span></Link></h2>
            <div className={styles.shortcuts} inert={labelsHidden} aria-hidden={labelsHidden}>
            {sessionShortcuts.map((item:any)=><Link key={item.id} className={styles.sessionRow} data-session-shortcut={item.id} aria-current={location.pathname==='/sessions/'+item.id?'page':undefined} to={'/sessions/'+encodeURIComponent(item.id)}>
              {item.cover&&<img src={item.cover} alt=""/>}<span className={styles.rowText}><strong>{item.title||'未命名会话'}</strong><small>{new Date(item.updatedAt).toLocaleDateString()}</small></span></Link>)}
            {sessions.error&&<button onClick={()=>void sessions.reload()}>会话加载失败，重试</button>}
            </div>
          </section>
          <section className={styles.dataSection} aria-labelledby="presets-heading">
            <h2 id="presets-heading" className={styles.sectionTitle}><Link to="/presets" title={labelsHidden?'预设列表':undefined} aria-label="预设列表" aria-current={presetHeadingActive?(location.pathname==='/presets'?'page':'location'):undefined} className={[styles.navItem,presetHeadingActive?styles.navSelected:''].join(' ')}><Layers3 size={20} strokeWidth={1.8} aria-hidden="true"/><span className={styles.navLabel} aria-hidden={labelsHidden}>预设列表</span></Link></h2>
            <div className={styles.shortcuts} inert={labelsHidden} aria-hidden={labelsHidden}>
            {presetShortcuts.map(preset=><Link key={preset.id} to={'/presets/'+preset.id} data-preset-shortcut={preset.id} aria-current={presetShortcutActive&&location.pathname==='/presets/'+preset.id?'page':undefined} className={styles.presetRow}>
              <span className={styles.presetName}>{preset.name || '未命名预设'}</span>{preset.id===defaultPresetId&&<span className={styles.defaultPill}>默认</span>}
            </Link>)}
            </div>
          </section>
          <section className={styles.dataSection} aria-labelledby="models-heading">
            <h2 id="models-heading" className={styles.sectionTitle}><Link to="/models" title={labelsHidden?'模型列表':undefined} aria-label="模型列表" aria-current={modelHeadingActive?(location.pathname==='/models'?'page':'location'):undefined} className={[styles.navItem,modelHeadingActive?styles.navSelected:''].join(' ')}><Box size={20} strokeWidth={1.8} aria-hidden="true"/><span className={styles.navLabel} aria-hidden={labelsHidden}>模型列表</span></Link></h2>
            <div className={styles.shortcuts} inert={labelsHidden} aria-hidden={labelsHidden}>
              {modelShortcuts.map((item:any)=><Link key={item.id} to={'/models/'+encodeURIComponent(item.id)} data-model-shortcut={item.id} aria-current={modelShortcutActive&&location.pathname==='/models/'+encodeURIComponent(item.id)?'page':undefined} className={styles.sessionRow}><span className={styles.rowText}><strong>{item.name}</strong><small>{item.providerId}</small></span></Link>)}
              {models.error&&<button onClick={()=>void models.reload()}>模型加载失败，重试</button>}
            </div>
          </section>
        </div>
        <div className={styles.bottom}>
          <button className={styles.bottomButton} title={labelsHidden?'设置':undefined} aria-label="设置" onClick={()=>nav('/settings')}>
            <Settings size={20} strokeWidth={1.8} aria-hidden="true"/>
            <span className={styles.bottomLabel} aria-hidden={labelsHidden}>设置</span>
          </button>
          <button className={styles.bottomButton} title={collapsed?'展开侧边栏':'收起侧边栏'}
            aria-label={collapsed?'展开侧边栏':'收起侧边栏'} aria-expanded={!collapsed}
            onClick={toggleCollapsed}>
            {collapsed?<PanelLeftOpen size={20} strokeWidth={1.8} aria-hidden="true"/>:<PanelLeftClose size={20} strokeWidth={1.8} aria-hidden="true"/>}
            <span className={styles.bottomLabel} aria-hidden={labelsHidden}>{collapsed?'展开侧边栏':'收起侧边栏'}</span>
          </button>
        </div>
      </div>
    </aside>
    <main className={[styles.main,isWorldDetail?styles.worldDetailMain:'',showMobileNav?styles.mobileListMain:''].join(' ')} id="main-content" tabIndex={-1}><Outlet context={{theme,toggleTheme}}/></main>
    {showMobileNav&&<nav className={styles.mobileNav} aria-label="手机主导航">
      {MOBILE_NAV.map(({path,label,Icon})=><NavLink key={path} to={path} end aria-label={label} className={({isActive})=>[styles.mobileNavItem,(isActive||path==='/settings'&&['/more','/setup'].includes(location.pathname))?styles.mobileNavSelected:''].join(' ')}><Icon size={20} strokeWidth={1.8} aria-hidden="true"/><span>{label}</span></NavLink>)}
    </nav>}

  </div>;
}
