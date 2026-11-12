import {useCallback,useEffect,useState} from 'react';
import {Link,NavLink,Outlet,useLocation,useMatch,useNavigate} from 'react-router-dom';
import {BookOpen,Box,Layers3,Menu,MessageCircle,Moon,PanelLeftClose,PanelLeftOpen,Settings,Sun,X} from 'lucide-react';
import {Modal} from '../components/ui/Modal';
import {useTheme} from '../hooks/useTheme';
import {usePresetStore} from '../features/presets/PresetStore';
import styles from './AppShell.module.css';

const NAV=[
  {title:'世界卡',path:'/worlds',Icon:BookOpen}
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
  const [showSettings,setShowSettings]=useState(false);
  const {theme,toggleTheme}=useTheme();
  useEffect(()=>{try{document.documentElement.dataset.palette=localStorage.getItem('sr-studio-palette')||'default';}catch{}},[]);
  const nav=useNavigate();
  const location=useLocation();
  const isWorldDetail=Boolean(useMatch('/worlds/:worldId'));
  const {presets,defaultPresetId}=usePresetStore();
  const presetShortcuts=[...presets.filter(preset=>preset.id===defaultPresetId),...presets.filter(preset=>preset.id!==defaultPresetId)].slice(0,2);
  const toggleCollapsed=()=>{
    setCollapsed(v=>{const n=!v;try{localStorage.setItem('sr-studio-sidebar',n?'collapsed':'expanded');}catch{}return n;});
  };
  useEffect(()=>setMobileOpen(false),[location.pathname]);
  const closeSettings=useCallback(()=>setShowSettings(false),[]);
  const labelsHidden=collapsed&&!mobileOpen;
  const sessionPaths=['/sessions/changan','/sessions/neon'];
  const sessionSection=location.pathname==='/sessions'||location.pathname.startsWith('/sessions/');
  const presetSection=location.pathname==='/presets'||location.pathname.startsWith('/presets/');
  const sessionShortcutActive=!labelsHidden&&sessionPaths.includes(location.pathname);
  const presetShortcutActive=!labelsHidden&&presetShortcuts.some(preset=>location.pathname==='/presets/'+preset.id);
  const sessionHeadingActive=sessionSection&&!sessionShortcutActive;
  const presetHeadingActive=presetSection&&!presetShortcutActive;
  return <div className={styles.layout} data-collapsed={collapsed?'true':'false'}>
    <a className={styles.skipLink} href="#main-content">跳转到主要内容</a>
    <button className={styles.mobileOpen} aria-label="打开导航" onClick={()=>setMobileOpen(true)}><Menu size={20}/></button>
    <button className={styles.mobileShade} data-open={mobileOpen} disabled={!mobileOpen} aria-hidden={!mobileOpen} aria-label="关闭导航遮罩" onClick={()=>setMobileOpen(false)}/>
    <aside className={[styles.sidebarWrap,mobileOpen?styles.mobileVisible:''].join(' ')}>
      <div className={styles.sidebar}>
        <div className={styles.brandRow}>
          <button className={styles.brand} title="返回世界卡" aria-label="返回世界卡" onClick={()=>nav('/worlds')}>
            <span className={styles.brandMark} aria-hidden="true">◢</span>
            <span className={styles.brandName} aria-hidden={labelsHidden}>SillyRealms</span>
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
            <button className={styles.sessionRow} aria-current={sessionShortcutActive&&location.pathname==='/sessions/changan'?'page':undefined} onClick={()=>nav('/sessions/changan')}>
              <img src="/covers/changan.webp" alt=""/>
              <span className={styles.rowText}><strong>长安风云</strong><small>初入长安</small></span>
            </button>
            <button className={styles.sessionRow} aria-current={sessionShortcutActive&&location.pathname==='/sessions/neon'?'page':undefined} onClick={()=>nav('/sessions/neon')}>
              <img src="/covers/neon.webp" alt=""/>
              <span className={styles.rowText}><strong>霓虹之城</strong><small>雨夜重逢</small></span>
            </button>
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
        </div>
        <div className={styles.bottom}>
          <button className={styles.bottomButton} title={labelsHidden?'设置':undefined} aria-label="设置" onClick={()=>setShowSettings(true)}>
            <Settings size={20} strokeWidth={1.8} aria-hidden="true"/>
            <span className={styles.bottomLabel} aria-hidden={labelsHidden}>设置</span>
          </button>
          <button className={styles.bottomButton} title={labelsHidden?'切换主题':undefined} aria-label={theme==='dark'?'切换亮色主题':'切换暗色主题'} onClick={toggleTheme}>
            {theme==='dark'?<Moon size={20} strokeWidth={1.8} aria-hidden="true"/>:<Sun size={20} strokeWidth={1.8} aria-hidden="true"/>}
            <span className={styles.bottomLabel} aria-hidden={labelsHidden}>主题</span>
          </button>
          <NavLink to="/models" title={labelsHidden?'模型':undefined} aria-label="模型" className={({isActive})=>[styles.bottomButton,isActive?styles.navSelected:''].join(' ')}>
            <Box size={20} strokeWidth={1.8} aria-hidden="true"/>
            <span className={styles.bottomLabel} aria-hidden={labelsHidden}>模型</span>
          </NavLink>
          <button className={styles.bottomButton} title={collapsed?'展开侧边栏':'收起侧边栏'}
            aria-label={collapsed?'展开侧边栏':'收起侧边栏'} aria-expanded={!collapsed}
            onClick={toggleCollapsed}>
            {collapsed?<PanelLeftOpen size={20} strokeWidth={1.8} aria-hidden="true"/>:<PanelLeftClose size={20} strokeWidth={1.8} aria-hidden="true"/>}
            <span className={styles.bottomLabel} aria-hidden={labelsHidden}>{collapsed?'展开侧边栏':'收起侧边栏'}</span>
          </button>
        </div>
      </div>
    </aside>
    <main className={[styles.main,isWorldDetail?styles.worldDetailMain:''].join(' ')} id="main-content" tabIndex={-1}><Outlet/></main>
    {showSettings&&<Modal title="外观设置" onClose={closeSettings}>
      <p>这里用于验证 SillyRealms 新平台的设置弹窗和主题交互，不会修改现有 SR 配置。</p>
      <div className={styles.settingRow}><span>当前主题</span><button onClick={toggleTheme}>{theme==='dark'?'深色':'浅色'} · 点击切换</button></div>
      <div className={styles.settingRow}><span>侧边栏</span><button onClick={toggleCollapsed}>{collapsed?'收起':'展开'} · 点击切换</button></div>
    </Modal>}
  </div>;
}
