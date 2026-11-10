import {useCallback,useEffect,useState} from 'react';
import {NavLink,Outlet,useLocation,useNavigate} from 'react-router-dom';
import {BookOpen,Box,ChevronLeft,ChevronRight,Layers3,Menu,MessageCircle,MonitorCog,Moon,PanelLeftClose,Settings,Sun,X} from 'lucide-react';
import {Modal} from '../components/ui/Modal';
import {useTheme} from '../hooks/useTheme';
import styles from './AppShell.module.css';

const NAV=[
  {title:'世界卡',path:'/worlds',Icon:BookOpen},
  {title:'会话',path:'/sessions',Icon:MessageCircle},
  {title:'预设',path:'/presets',Icon:Layers3},
  {title:'模型配置',path:'/models',Icon:Box}
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
  const toggleCollapsed=()=>{
    setCollapsed(v=>{const n=!v;try{localStorage.setItem('sr-studio-sidebar',n?'collapsed':'expanded');}catch{}return n;});
  };
  useEffect(()=>setMobileOpen(false),[location.pathname]);
  const closeSettings=useCallback(()=>setShowSettings(false),[]);
  return <div className={styles.layout} data-collapsed={collapsed?'true':'false'}>
    <button className={styles.mobileOpen} aria-label="打开导航" onClick={()=>setMobileOpen(true)}><Menu size={20}/></button>
    {mobileOpen&&<button className={styles.mobileShade} aria-label="关闭导航" onClick={()=>setMobileOpen(false)}/>}
    <aside className={[styles.sidebarWrap,mobileOpen?styles.mobileVisible:''].join(' ')}>
      <div className={styles.sidebar}>
        <div className={styles.brandRow}>
          <button className={styles.brand} title={collapsed?'展开侧边栏':'SillyRealms'} onClick={collapsed&&!mobileOpen?toggleCollapsed:()=>nav('/worlds')} aria-label={collapsed?'展开侧边栏':'返回世界卡'}>
            <span className={styles.brandMark}>{collapsed&&!mobileOpen?'SR':'◢'}</span>
            {(!collapsed||mobileOpen)&&<span className={styles.brandName}>SillyRealms</span>}
          </button>
          {!collapsed&&<button className={styles.collapseButton} aria-label="收起侧边栏" title="收起侧边栏" onClick={toggleCollapsed}><PanelLeftClose size={17}/></button>}
          <button className={styles.mobileClose} aria-label="关闭导航" onClick={()=>setMobileOpen(false)}><X size={19}/></button>
        </div>

        <nav className={styles.primaryNav} aria-label="主导航">
          {NAV.map(({title,path,Icon})=><NavLink key={path} to={path} title={collapsed?title:undefined} aria-label={title} className={({isActive})=>[styles.navItem,isActive?styles.navSelected:''].join(' ')}>
            <Icon size={20} strokeWidth={1.8} aria-hidden="true"/>
            {(!collapsed||mobileOpen)&&<span>{title}</span>}
          </NavLink>)}
        </nav>
        {(!collapsed||mobileOpen)&&<div className={styles.sidebarData}>
          <section className={styles.dataSection} aria-labelledby="sessions-heading">
            <h2 id="sessions-heading" className={styles.sectionTitle}>会话列表</h2>
            <button className={styles.sessionRow} onClick={()=>nav('/sessions/changan')}>
              <img src="/covers/changan.webp" alt=""/>
              <span className={styles.rowText}><strong>长安风云</strong><small>初入长安</small></span>
              <span className={styles.more} aria-hidden="true">···</span>
            </button>
            <button className={styles.sessionRow} onClick={()=>nav('/sessions/neon')}>
              <img src="/covers/neon.webp" alt=""/>
              <span className={styles.rowText}><strong>霓虹之城</strong><small>雨夜重逢</small></span>
              <span className={styles.more} aria-hidden="true">···</span>
            </button>
          </section>
          <section className={styles.dataSection} aria-labelledby="presets-heading">
            <h2 id="presets-heading" className={styles.sectionTitle}>预设列表</h2>
            <button className={styles.presetRow} onClick={()=>nav('/presets/general')}><span>通用叙事</span><span className={styles.defaultPill}>默认</span></button>
            <button className={styles.presetRow} onClick={()=>nav('/presets/roleplay')}>角色扮演</button>
          </section>
        </div>}
        <div className={styles.bottom}>
          <button className={styles.bottomButton} title="设置" aria-label="设置" onClick={()=>setShowSettings(true)}><Settings size={20}/>{(!collapsed||mobileOpen)&&<span>设置</span>}</button>
          <button className={styles.bottomButton} title={theme==='dark'?'切换亮色主题':'切换暗色主题'} aria-label={theme==='dark'?'切换亮色主题':'切换暗色主题'} onClick={toggleTheme}>
            {theme==='dark'?<Moon size={20}/>:<Sun size={20}/>}
            {(!collapsed||mobileOpen)&&<span>主题</span>}
          </button>
          {collapsed&&!mobileOpen&&<button className={styles.expandAtBottom} aria-label="展开侧边栏" title="展开侧边栏" onClick={toggleCollapsed}><ChevronRight size={18}/></button>}
        </div>
      </div>
    </aside>
    <main className={styles.main} id="main-content"><Outlet/></main>
    {showSettings&&<Modal title="外观设置" onClose={closeSettings}>
      <p>这里用于验证 SillyRealms 新平台的设置弹窗和主题交互，不会修改现有 SR 配置。</p>
      <div className={styles.settingRow}><span>当前主题</span><button onClick={toggleTheme}>{theme==='dark'?'深色':'浅色'} · 点击切换</button></div>
      <div className={styles.settingRow}><span>侧边栏</span><button onClick={toggleCollapsed}>{collapsed?'收起':'展开'} · 点击切换</button></div>
    </Modal>}
  </div>;
}
