import React from 'react';
import {SR,useSRStateAPI,useSRSession} from '@sillyrealms/sdk';
import Styles from './Styles';
import Casebook from './Casebook';
import Library from './Library';
const roots=['identity','case','scene','evidence','actors','pending','notebook','ending'];
const query='(min-width:1000px)';
export default function ForumStage(){
 const state=useSRStateAPI(),session=useSRSession();
 const [values,setValues]=React.useState<any>(null),[error,setError]=React.useState(false),[retry,setRetry]=React.useState(0);
 const [connected,setConnected]=React.useState(false),[wide,setWide]=React.useState(()=>window.matchMedia(query).matches),[open,setOpen]=React.useState(()=>window.matchMedia(query).matches),[tab,setTab]=React.useState('evidence');
 const dialog=React.useRef<HTMLDialogElement>(null),toggle=React.useRef<HTMLButtonElement>(null),dialogId=React.useId();
 React.useEffect(()=>{const m=window.matchMedia(query),change=()=>{setWide(m.matches);setOpen(m.matches);};m.addEventListener('change',change);change();return()=>m.removeEventListener('change',change);},[]);
 React.useEffect(()=>{let disposed=false,revision=0,timer:ReturnType<typeof setTimeout>;const refresh=()=>{const ticket=++revision;clearTimeout(timer);timer=setTimeout(async()=>{try{const entries=await state.batchGetState(roots.map(path=>({path,scope:'message' as const})));if(disposed||ticket!==revision)return;if(roots.some(root=>!entries.some(e=>e.path===root&&e.value!==undefined)))throw Error('Missing state');setValues(Object.fromEntries(entries.map(e=>[e.path,e.value])));setError(false);}catch{if(!disposed&&ticket===revision)setError(true);}},0);};const off=state.subscribe(e=>{if(e.data.scope==='message'&&roots.includes(e.data.path.split('.')[0]))refresh();});const offSession=session.subscribe(e=>{if(e.event==='session.connection'){setConnected(e.data.connected);if(e.data.connected)refresh();}});refresh();return()=>{disposed=true;revision++;clearTimeout(timer);off();offSession();};},[state,session,retry]);
 React.useEffect(()=>{const node=dialog.current;if(!node||wide||!open)return;node.showModal();return()=>{if(node.open)node.close();};},[wide,open]);
 const close=()=>{dialog.current?.close();setOpen(false);toggle.current?.focus();};
 const role=Library.data.roles.find(r=>r.id===values?.identity?.role)?.name??'正在读取';
 const privateChat=values?.scene?.channel==='private';
 const props={values,tab,onTab:setTab};
 return <div className="ww"><Styles/><header className="ww-top"><div className="ww-title"><h1>窗边的女人</h1><small>宁温河馨 · 2016.02.01</small></div><div className="ww-session"><strong>{role} · {privateChat?'私聊中':'公共聊天室'}</strong>{privateChat?'仅参与者可见本次交谈':'六个网名，一桩旧案。'}</div><button className="ww-toggle" ref={toggle} aria-expanded={open} aria-controls={dialogId} onClick={()=>setOpen(!open)}>{open?'收起案卷':'打开案卷'}</button></header><nav className="ww-phase" aria-label="剧本进度">{['寻尸','事件','修罗道','选择','复盘'].map((label,i)=><span key={label} data-current={values?.case?.phase===i+1}>{i+1} · {label}</span>)}</nav>{error?<div role="alert" className="ww-notice">案卷暂未同步，保留上次记录。<button onClick={()=>setRetry(n=>n+1)}>重试</button></div>:!values?<div className="ww-notice">正在读取案卷…</div>:null}{!connected&&values&&<div className="ww-notice">连接尚未确认；案卷显示上次提交的记录。</div>}<div className="ww-layout" data-docked={wide&&open}><section className="ww-story" aria-label="论坛故事"><SR.WorldStory showState={false}/></section>{wide&&open&&<aside id={dialogId} className="ww-side" aria-label="旧案卷宗"><Casebook {...props}/></aside>}</div>{!wide&&open&&<dialog id={dialogId} ref={dialog} className="ww-dialog" aria-label="旧案卷宗" onCancel={e=>{e.preventDefault();close();}}><div className="ww-dialog-close"><button autoFocus onClick={close}>收起案卷</button></div><Casebook {...props}/></dialog>}</div>;
}
