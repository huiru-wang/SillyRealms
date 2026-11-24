import {useTranslation} from 'react-i18next';
import {i18n} from '../i18n/instance.ts';
import {useEffect,useState} from 'react';
import {Link,NavLink,Outlet,useLocation,useNavigate} from 'react-router-dom';
import {BookOpen,Box,Layers3,Menu,MessageCircle,PanelLeftClose,PanelLeftOpen,Settings,X} from 'lucide-react';
import {usePagedResource} from '../data';
import {useManagement} from './ManagementData';
import type {ModelConfig} from '../features/models/types';
import {useTheme} from '../hooks/useTheme';
import {usePresetStore} from '../features/presets/PresetStore';
import styles from './AppShell.module.css';




function getCollapse(){
  const p=new URLSearchParams(location.search).get('sidebar');
  if(p==='collapsed')return true;
  if(p==='expanded')return false;
  try{return localStorage.getItem('sr-studio-sidebar')==='collapsed';}catch{return false;}
}
export function AppShell(){
  const MOBILE_NAV=[
  {path:'/worlds',label:i18n.t("common:worlds"),Icon:BookOpen},
  {path:'/presets',label:i18n.t("common:presets"),Icon:Layers3},
  {path:'/sessions',label:i18n.t("common:sessions"),Icon:MessageCircle},
  {path:'/models',label:i18n.t("common:models"),Icon:Box},
  {path:'/settings',label:i18n.t("common:settings"),Icon:Settings}
] as const;
  useTranslation();
  const [collapsed,setCollapsed]=useState(getCollapse);
  const [mobileOpen,setMobileOpen]=useState(false);
  const {sessionsRevision,modelsRevision}=useManagement();
  const sessions=usePagedResource<{id:string;title:string|null;updatedAt:number}>('v1/sessions?limit=2',sessionsRevision);
  const models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=2',modelsRevision);
  const modelShortcuts=models.page?.items??[];
  const sessionShortcuts=sessions.page?.items??[];
  const {theme,toggleTheme}=useTheme();

  const nav=useNavigate();
  const location=useLocation();
  const isSessionDetail=/^\/sessions\/[^/]+\/?$/.test(location.pathname);
  const isWorldDetail=/^\/worlds\/[^/]+\/?$/.test(location.pathname);
  const isLibraryDetail=/^\/(?:worlds|sessions|presets|models)\/[^/]+\/?$/.test(location.pathname);
  const showMobileNav=!isSessionDetail&&(isLibraryDetail||['/worlds','/sessions','/presets','/models','/settings'].includes(location.pathname.replace(/\/+$/,'')||'/'));
  const {presets,defaultPresetId}=usePresetStore();
  const presetShortcuts=[...presets.filter(preset=>preset.id===defaultPresetId),...presets.filter(preset=>preset.id!==defaultPresetId)].slice(0,2);
  const toggleCollapsed=()=>{
    setCollapsed(v=>{const n=!v;try{localStorage.setItem('sr-studio-sidebar',n?'collapsed':'expanded');}catch{}return n;});
  };
  useEffect(()=>setMobileOpen(false),[location.pathname]);

  const labelsHidden=collapsed&&!mobileOpen;
  const sessionPaths=sessionShortcuts.map((item)=>'/sessions/'+encodeURIComponent(item.id));
  const sessionSection=location.pathname==='/sessions'||location.pathname.startsWith('/sessions/');
  const presetSection=location.pathname==='/presets'||location.pathname.startsWith('/presets/');
  const sessionShortcutActive=!labelsHidden&&sessionPaths.includes(location.pathname);
  const presetShortcutActive=!labelsHidden&&presetShortcuts.some(preset=>location.pathname==='/presets/'+preset.id);
  const sessionHeadingActive=sessionSection&&!sessionShortcutActive;
  const presetHeadingActive=presetSection&&!presetShortcutActive;
  const modelSection=location.pathname==='/models'||location.pathname.startsWith('/models/');
  const modelShortcutActive=!labelsHidden&&modelShortcuts.some((item)=>location.pathname==='/models/'+encodeURIComponent(item.id));
  const modelHeadingActive=modelSection&&!modelShortcutActive;
  return <div className={styles.layout} data-collapsed={collapsed?'true':'false'}>
    <a className={styles.skipLink} href="#main-content">{i18n.t("common:skipToContent")}</a>
    <button className={styles.mobileOpen} aria-label={i18n.t("common:openNavigation")} onClick={()=>setMobileOpen(true)}><Menu size={20}/></button>
    <button className={styles.mobileShade} data-open={mobileOpen} disabled={!mobileOpen} aria-hidden={!mobileOpen} aria-label={i18n.t("common:closeNavigationShade")} onClick={()=>setMobileOpen(false)}/>
    <aside className={[styles.sidebarWrap,mobileOpen?styles.mobileVisible:''].join(' ')}>
      <div className={styles.sidebar}>
        <div className={styles.brandRow}>
          <button className={styles.brand} title={i18n.t("common:backToPresets")} aria-label={i18n.t("common:backToPresets")} onClick={()=>nav('/presets')}>
            <span className={styles.brandName}>{labelsHidden?'SR':'SillyRealms'}</span>
          </button>
          <button className={styles.mobileClose} aria-label={i18n.t("common:closeNavigation")} onClick={()=>setMobileOpen(false)}><X size={19}/></button>
        </div>

        <div className={styles.sidebarData}>
          <section className={styles.dataSection}><h2 className={styles.sectionTitle}><NavLink to="/worlds" className={({isActive})=>[styles.navItem,isActive?styles.navSelected:''].join(' ')} aria-label={i18n.t("common:worlds")}><BookOpen size={20}/><span className={styles.navLabel} aria-hidden={labelsHidden}>{i18n.t("common:worlds")}</span></NavLink></h2></section>
          <section className={styles.dataSection} aria-labelledby="sessions-heading">
            <h2 id="sessions-heading" className={styles.sectionTitle}><Link to="/sessions" title={labelsHidden?i18n.t("common:sessionList"):undefined} aria-label={i18n.t("common:sessionList")} aria-current={sessionHeadingActive?(location.pathname==='/sessions'?'page':'location'):undefined} className={[styles.navItem,sessionHeadingActive?styles.navSelected:''].join(' ')}><MessageCircle size={20} strokeWidth={1.8} aria-hidden="true"/><span className={styles.navLabel} aria-hidden={labelsHidden}>{i18n.t("common:sessionList")}</span></Link></h2>
            <div className={styles.shortcuts} inert={labelsHidden} aria-hidden={labelsHidden}>
            {sessionShortcuts.map((item)=><Link key={item.id} className={styles.sessionRow} data-session-shortcut={item.id} aria-current={location.pathname==='/sessions/'+item.id?'page':undefined} to={'/sessions/'+encodeURIComponent(item.id)}>
              <span className={styles.rowText}><strong>{item.title||i18n.t("common:untitledSession")}</strong><small>{new Date(item.updatedAt).toLocaleDateString(i18n.resolvedLanguage)}</small></span></Link>)}
            {sessions.error&&<button onClick={()=>void sessions.reload()}>{i18n.t("common:sessionsLoadRetry")}</button>}
            </div>
          </section>
          <section className={styles.dataSection} aria-labelledby="presets-heading">
            <h2 id="presets-heading" className={styles.sectionTitle}><Link to="/presets" title={labelsHidden?i18n.t("common:presetList"):undefined} aria-label={i18n.t("common:presetList")} aria-current={presetHeadingActive?(location.pathname==='/presets'?'page':'location'):undefined} className={[styles.navItem,presetHeadingActive?styles.navSelected:''].join(' ')}><Layers3 size={20} strokeWidth={1.8} aria-hidden="true"/><span className={styles.navLabel} aria-hidden={labelsHidden}>{i18n.t("common:presetList")}</span></Link></h2>
            <div className={styles.shortcuts} inert={labelsHidden} aria-hidden={labelsHidden}>
            {presetShortcuts.map(preset=><Link key={preset.id} to={'/presets/'+preset.id} data-preset-shortcut={preset.id} aria-current={presetShortcutActive&&location.pathname==='/presets/'+preset.id?'page':undefined} className={styles.presetRow}>
              <span className={styles.presetName}>{preset.name || i18n.t("common:untitledPreset")}</span>{preset.id===defaultPresetId&&<span className={styles.defaultPill}>{i18n.t("common:default")}</span>}
            </Link>)}
            </div>
          </section>
          <section className={styles.dataSection} aria-labelledby="models-heading">
            <h2 id="models-heading" className={styles.sectionTitle}><Link to="/models" title={labelsHidden?i18n.t("common:modelList"):undefined} aria-label={i18n.t("common:modelList")} aria-current={modelHeadingActive?(location.pathname==='/models'?'page':'location'):undefined} className={[styles.navItem,modelHeadingActive?styles.navSelected:''].join(' ')}><Box size={20} strokeWidth={1.8} aria-hidden="true"/><span className={styles.navLabel} aria-hidden={labelsHidden}>{i18n.t("common:modelList")}</span></Link></h2>
            <div className={styles.shortcuts} inert={labelsHidden} aria-hidden={labelsHidden}>
              {modelShortcuts.map((item)=><Link key={item.id} to={'/models/'+encodeURIComponent(item.id)} data-model-shortcut={item.id} aria-current={modelShortcutActive&&location.pathname==='/models/'+encodeURIComponent(item.id)?'page':undefined} className={styles.sessionRow}><span className={styles.rowText}><strong>{item.name}</strong><small>{item.providerId}</small></span></Link>)}
              {models.error&&<button onClick={()=>void models.reload()}>{i18n.t("common:modelsLoadRetry")}</button>}
            </div>
          </section>
        </div>
        <div className={styles.bottom}>
          <button className={styles.bottomButton} title={labelsHidden?i18n.t("common:settings"):undefined} aria-label={i18n.t("common:settings")} onClick={()=>nav('/settings')}>
            <Settings size={20} strokeWidth={1.8} aria-hidden="true"/>
            <span className={styles.bottomLabel} aria-hidden={labelsHidden}>{i18n.t("common:settings")}</span>
          </button>
          <button className={styles.bottomButton} title={collapsed?i18n.t("common:expandSidebar"):i18n.t("common:collapseSidebar")}
            aria-label={collapsed?i18n.t("common:expandSidebar"):i18n.t("common:collapseSidebar")} aria-expanded={!collapsed}
            onClick={toggleCollapsed}>
            {collapsed?<PanelLeftOpen size={20} strokeWidth={1.8} aria-hidden="true"/>:<PanelLeftClose size={20} strokeWidth={1.8} aria-hidden="true"/>}
            <span className={styles.bottomLabel} aria-hidden={labelsHidden}>{collapsed?i18n.t("common:expandSidebar"):i18n.t("common:collapseSidebar")}</span>
          </button>
        </div>
      </div>
    </aside>
    <main className={[styles.main,isWorldDetail?styles.worldDetailMain:'',showMobileNav?(isLibraryDetail?styles.mobileDetailMain:styles.mobileListMain):''].join(' ')} id="main-content" tabIndex={-1}><Outlet context={{theme,toggleTheme}}/></main>
    {showMobileNav&&<nav className={styles.mobileNav} aria-label={i18n.t("common:mobileNavigation")}>
      {MOBILE_NAV.map(({path,label,Icon})=><NavLink key={path} to={path} end={path==='/sessions'||path==='/settings'} aria-label={label} className={({isActive})=>[styles.mobileNavItem,isActive?styles.mobileNavSelected:''].join(' ')}><Icon size={20} strokeWidth={1.8} aria-hidden="true"/><span>{label}</span></NavLink>)}
    </nav>}

  </div>;
}
