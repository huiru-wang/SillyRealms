import React,{useEffect,useState} from 'react';
import {BrowserRouter,Link,NavLink,Navigate,Route,Routes,useLocation,useParams} from 'react-router-dom';
import {BookOpen,Layers3,Menu,MessagesSquare,PanelLeftClose,PanelLeftOpen,Plug,Settings2,SlidersHorizontal,X} from 'lucide-react';
import {SessionHost} from '../host';
import {SessionsPage} from '../features/sessions/SessionsPage';
import {WorldLibraryPage} from '../features/worlds/WorldLibraryPage';
import {WorldDetailPage} from '../features/worlds/WorldDetailPage';
import {PresetLibraryPage} from '../features/presets/PresetLibraryPage';
import {PresetPage} from '../features/presets/PresetPage';
import {ModelsPage} from '../features/models/ModelsPage';
import {SettingsPage} from '../features/settings/SettingsPage';
import {SetupPage} from '../features/onboarding/SetupPage';
import {Loading,useLoad} from './ui';

const primary=[{to:'/sessions',title:'会话',icon:MessagesSquare},{to:'/worlds',title:'世界库',icon:BookOpen}];
const tools=[{to:'/presets',title:'预设',icon:SlidersHorizontal},{to:'/providers',title:'模型连接',icon:Plug}];
const navigation=[...primary,...tools,{to:'/settings',title:'设置',icon:Settings2}];
function Landing(){
 const settings=useLoad('v1/app-settings'),models=useLoad('v1/api-model-configs');
 if((!settings.value&&!settings.error)||(!models.value&&!models.error))return <main className="page"><Loading text="正在打开工作区…"/></main>;
 const selected=settings.value?.item?.defaultApiModelConfigId;
 const usable=!!settings.value?.item?.defaultPresetId&&!!models.value?.items?.find((item:any)=>item.id===selected&&item.credentialConfigured);
 return <Navigate replace to={usable?'/sessions':'/setup'}/>;
}
function SessionRoute(){const {id}=useParams();return <SessionHost key={id} id={id!}/>;}
function Shell(){
 const location=useLocation();
 const [mobileOpen,setMobileOpen]=useState(false),[collapsed,setCollapsed]=useState(()=>localStorage.getItem('sr-nav-collapsed')==='true');
 const inSession=/^\/sessions\/[^/]+/.test(location.pathname);
 useEffect(()=>{document.documentElement.dataset.theme=localStorage.getItem('sr-theme')??'light';document.documentElement.dataset.density=localStorage.getItem('sr-density')??'comfortable';},[]);
 useEffect(()=>setMobileOpen(false),[location.pathname]);
 const navLink=(item:{to:string;title:string;icon:React.ComponentType<{size?:number}>})=>{
   const Icon=item.icon;return <NavLink key={item.to} to={item.to} title={item.title} aria-label={item.title} onClick={()=>setMobileOpen(false)} className={({isActive})=>'side-link'+(isActive?' active':'')}><Icon size={18}/><span>{item.title}</span></NavLink>;
 };
 return <div className={'app-shell sr-shell'+(collapsed?' is-collapsed':'')+(inSession?' is-session':'')}>
   <aside className="app-sidebar">
     <Link className="sidebar-brand" to="/sessions"><span className="brand-mark"><Layers3 size={20}/></span><span className="brand-copy"><b>SillyRealms</b><small>STORY WORKSPACE</small></span></Link>
     <nav className="side-nav" aria-label="工作区导航">{navigation.map(navLink)}</nav>
     <div className="sidebar-bottom">
       <div className="workspace-status"><span className="status-dot"/><span><b>本地工作区</b><small>数据由本机保存</small></span></div>
       <button className="sidebar-collapse" aria-label={collapsed?'展开导航':'折叠导航'} onClick={()=>{setCollapsed(x=>{localStorage.setItem('sr-nav-collapsed',String(!x));return !x;});}}>{collapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}<span>{collapsed?'':'收起侧栏'}</span></button>
     </div>
   </aside>
   <div className="app-main">
     <button className="mobile-menu" aria-label={mobileOpen?'关闭导航':'打开导航'} aria-expanded={mobileOpen} onClick={()=>setMobileOpen(x=>!x)}><Menu size={19}/></button>
     {mobileOpen&&<>
       <button className="mobile-nav-backdrop" aria-label="关闭导航" onClick={()=>setMobileOpen(false)}/>
       <aside className="mobile-drawer" aria-label="移动导航">
         <div className="mobile-drawer-header">
           <Link className="sidebar-brand" to="/sessions" onClick={()=>setMobileOpen(false)}><span className="brand-mark"><Layers3 size={20}/></span><span className="brand-copy"><b>SillyRealms</b><small>STORY WORKSPACE</small></span></Link>
           <button className="mobile-drawer-close" aria-label="关闭导航" onClick={()=>setMobileOpen(false)}><X size={19}/></button>
         </div>
         <nav className="mobile-drawer-nav" aria-label="工作区导航">{navigation.map(navLink)}</nav>
       </aside>
     </>}
     <div className="workspace-content"><Routes>
       <Route path="/" element={<Landing/>}/>
       <Route path="/setup" element={<SetupPage/>}/>
       <Route path="/sessions" element={<SessionsPage/>}/>
       <Route path="/sessions/:id" element={<SessionRoute/>}/>
       <Route path="/worlds" element={<WorldLibraryPage/>}/>
       <Route path="/worlds/:id" element={<WorldDetailPage/>}/>
       <Route path="/presets" element={<PresetLibraryPage/>}/>
       <Route path="/presets/new" element={<PresetPage isNew/>}/>
       <Route path="/presets/:id" element={<PresetPage/>}/>
       <Route path="/providers" element={<ModelsPage/>}/>
       <Route path="/settings" element={<SettingsPage/>}/>
       <Route path="*" element={<Navigate to="/sessions" replace/>}/>
     </Routes></div>
   </div>
 </div>;
}
export default function App(){return <BrowserRouter><Shell/></BrowserRouter>;}
