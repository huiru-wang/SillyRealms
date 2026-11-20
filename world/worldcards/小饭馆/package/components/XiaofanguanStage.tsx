/* Reading first; a quiet household notebook is secondary. Only public SDK APIs
 * and --sr-story-* tokens are used. The Host owns input and Run lifecycle. */
import React from 'react';
import {SR,useSRStateAPI,useSRStageSnapshot,useSRAssetUrl} from '@sillyrealms/sdk';
import HouseholdPanel from './HouseholdPanel';

const roots=['scene','family','kitchen','recipes','ledger','wishes','neighbors'];
const wideQuery='(min-width: 1000px)';
const css=`
.xf-stage{--xf-paper:#fcfbee;--xf-sheet:#ebe8d4;--xf-line:#d8d3bb;--xf-ink:#36261c;--xf-muted:#776150;--xf-accent:#9b462b;--xf-hover:#e4dfc7;--sr-story-bg:var(--xf-paper);--sr-story-surface:var(--xf-paper);--sr-story-text:var(--xf-ink);--sr-story-muted:var(--xf-muted);--sr-story-line:var(--xf-line);--sr-story-accent:var(--xf-accent);--sr-story-focus:var(--xf-accent);--sr-story-speech:var(--xf-accent);--sr-story-danger:var(--xf-accent);height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;color:var(--xf-ink);background:var(--xf-paper);font:400 14px/1.7 'PingFang SC','Microsoft YaHei',sans-serif;color-scheme:light}
.xf-stage *{box-sizing:border-box}.xf-stage h1,.xf-stage h2,.xf-stage h3,.xf-stage h4,.xf-stage p{margin:0}.xf-stage button,.xf-stage summary{font:inherit}.xf-stage button{cursor:pointer}.xf-stage button:disabled{cursor:wait;opacity:.6}.xf-stage button:focus-visible,.xf-stage summary:focus-visible{outline:2px solid var(--xf-accent);outline-offset:3px}.xf-stage img{display:block;width:100%;height:100%;object-fit:cover}.xf-stage .xf-top{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:24px;padding:12px 24px;border-bottom:1px solid var(--xf-line);flex:none}.xf-stage .xf-brand{display:flex;align-items:center;gap:12px}.xf-stage .xf-owner{width:40px;height:40px;overflow:hidden;border-radius:50%;background:var(--xf-sheet);display:grid;place-items:center;color:var(--xf-accent)}.xf-stage .xf-owner img{object-position:50% 15%}.xf-stage .xf-brand h1{font:400 24px/1.3 'Songti SC','STSong',serif;letter-spacing:.12em}.xf-stage .xf-brand small{font-size:11px;letter-spacing:.12em;color:var(--xf-muted)}.xf-stage .xf-scene{min-width:0;overflow-wrap:anywhere;display:flex;gap:8px 16px;flex-wrap:wrap;color:var(--xf-muted);font-size:12px;justify-content:center}.xf-stage .xf-scene>span{max-width:100%}.xf-stage .xf-connection{color:var(--xf-accent)}.xf-stage .xf-toggle{border:1px solid var(--xf-line);border-radius:4px;background:transparent;color:var(--xf-ink);min-height:44px;padding:8px 16px;transition:background .16s}.xf-stage .xf-toggle:hover{background:var(--xf-sheet)}.xf-stage .xf-toggle[aria-expanded=true]{border-color:var(--xf-accent);color:var(--xf-accent)}
.xf-stage .xf-layout{display:grid;grid-template-columns:minmax(0,1fr);flex:1;min-height:0;overflow:hidden}.xf-stage .xf-layout[data-docked=true]{grid-template-columns:minmax(0,1fr) 320px}.xf-stage .xf-reading{min-width:0;min-height:0;height:100%;overflow:hidden}.xf-stage .xf-side{min-width:0;min-height:0;background:var(--xf-sheet);border-left:1px solid var(--xf-line);padding-bottom:var(--sr-story-bottom-inset,0px);overflow:hidden}.xf-stage .xf-book{height:100%;min-height:0;display:flex;flex-direction:column}.xf-stage .xf-book-title{display:flex;justify-content:space-between;align-items:center;padding:24px 24px 16px;gap:16px}.xf-stage .xf-eyebrow{font-size:11px;color:var(--xf-muted);letter-spacing:.08em}.xf-stage .xf-book-title h2{font:400 32px/1.5 'Songti SC','STSong',serif;letter-spacing:.1em}.xf-stage .xf-book-day{text-align:right;font-size:14px}.xf-stage .xf-book-day small{display:block;font-size:11px;color:var(--xf-muted)}.xf-stage .xf-book-tabs{display:flex;margin-inline:24px;gap:8px;border-bottom:1px solid var(--xf-line);flex:none}.xf-stage .xf-book-tabs button{flex:1;min-height:44px;padding:8px;border:0;border-bottom:2px solid transparent;color:var(--xf-muted);background:transparent;transition:color .16s,background .16s}.xf-stage .xf-book-tabs button:hover{background:var(--xf-hover)}.xf-stage .xf-book-tabs button[aria-pressed=true]{color:var(--xf-accent);border-bottom-color:var(--xf-accent);font-weight:600}.xf-stage .xf-book-content{padding:0 24px 32px;overflow:auto;min-height:0;flex:1;overscroll-behavior:contain;scrollbar-width:thin}.xf-stage .xf-book-section{padding-top:24px}.xf-stage .xf-book-section h3{font-size:12px;color:var(--xf-muted);font-weight:600;letter-spacing:.1em;margin-bottom:12px}.xf-stage .xf-empty,.xf-stage .xf-explanation{font-size:13px;color:var(--xf-muted);padding:12px 0;line-height:1.8}.xf-stage .xf-avatar{width:48px;height:48px;flex:none;border-radius:50%;overflow:hidden;background:var(--xf-paper);display:grid;place-items:center;color:var(--xf-accent)}.xf-stage .xf-person{border-bottom:1px solid var(--xf-line)}.xf-stage .xf-person summary{display:flex;align-items:center;gap:12px;cursor:pointer;min-height:80px;padding-block:12px;list-style:none}.xf-stage summary::-webkit-details-marker{display:none}.xf-stage .xf-person-copy{min-width:0;flex:1}.xf-stage .xf-person-copy strong{display:block;font-weight:600;font-size:16px}.xf-stage .xf-person-copy>span{display:block;color:var(--xf-muted);font-size:12px;line-height:1.6;margin-top:4px;overflow-wrap:anywhere}.xf-stage .xf-disclosure{color:var(--xf-muted);flex:none}.xf-stage .xf-person[open] .xf-disclosure{transform:rotate(45deg)}.xf-stage .xf-person-detail{margin:0;padding:4px 0 16px;font-size:12px}.xf-stage .xf-person-detail>div{display:grid;grid-template-columns:64px 1fr;gap:8px;margin-top:8px}.xf-stage dt{color:var(--xf-muted)}.xf-stage dd{margin:0;overflow-wrap:anywhere}.xf-stage .xf-row-heading{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.xf-stage .xf-stamp{display:inline-block;font-size:11px;line-height:1.6;color:var(--xf-accent);border:1px solid var(--xf-line);padding:2px 6px;border-radius:2px;max-width:100%}.xf-stage .xf-stamp[data-done=true]{color:var(--xf-muted)}.xf-stage .xf-wish,.xf-stage .xf-order,.xf-stage .xf-stock,.xf-stage .xf-recipe,.xf-stage .xf-transaction,.xf-stage .xf-neighbor{padding:16px 0;border-bottom:1px solid var(--xf-line);overflow-wrap:anywhere}.xf-stage .xf-wish .xf-row-heading{font-size:12px;color:var(--xf-muted)}.xf-stage .xf-wish p,.xf-stage .xf-recipe p,.xf-stage .xf-transaction p,.xf-stage .xf-neighbor p{margin-top:8px}.xf-stage .xf-book-content small{display:block;color:var(--xf-muted);font-size:12px;line-height:1.8;margin-top:8px}.xf-stage .xf-fold{margin-top:24px}.xf-stage .xf-fold>summary{min-height:44px;display:flex;align-items:center;justify-content:space-between;font-weight:600;cursor:pointer;border-bottom:1px solid var(--xf-line);list-style:none}.xf-stage .xf-fold>summary:after{content:'＋';font-weight:400;color:var(--xf-muted)}.xf-stage .xf-fold[open]>summary:after{content:'－'}.xf-stage h4{font-size:15px;font-weight:600}.xf-stage .xf-order-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:12px}.xf-stage .xf-order-item>span:first-child{min-width:0;flex:1}.xf-stage .xf-order-item small{margin-top:0}.xf-stage .xf-order-item .xf-stamp{flex:none;max-width:45%}.xf-stage .xf-weather{margin-top:16px}.xf-stage .xf-weather p{font-family:'Songti SC','STSong',serif;font-size:18px}.xf-stage .xf-notice{font-size:12px;color:var(--xf-accent);padding:16px 0;border-bottom:1px solid var(--xf-line)}.xf-stage .xf-notice button{display:block;min-height:44px;border:0;background:transparent;color:inherit;text-decoration:underline;padding:8px 0}.xf-stage .xf-book-end{font:400 14px/1.8 'Songti SC','STSong',serif;color:var(--xf-muted);padding-top:32px}
.xf-stage .xf-dialog{background:var(--xf-sheet);color:var(--xf-ink);border:1px solid var(--xf-line);border-radius:12px 12px 4px 4px;padding:0;position:fixed;inset:auto 12px calc(var(--sr-story-bottom-inset,0px) + 12px);margin:0;width:calc(100% - 24px);max-width:600px;height:min(82%,calc(100% - var(--sr-story-bottom-inset,0px) - 24px));max-height:calc(100% - var(--sr-story-bottom-inset,0px) - 24px);overflow:hidden}.xf-stage .xf-dialog[open]{display:flex;flex-direction:column}.xf-stage .xf-dialog::backdrop{background:rgb(25 18 12 / .35)}.xf-stage .xf-dialog-close{display:flex;justify-content:flex-end;flex:none;padding:8px 16px 0}.xf-stage .xf-dialog-close button{border:0;background:transparent;color:var(--xf-accent);padding:8px 12px;min-height:44px}.xf-stage .xf-dialog .xf-book{flex:1;height:auto}.xf-stage .xf-dialog .xf-book-title{padding-top:0}
:root[data-theme=dark] .xf-stage{--xf-paper:#36261c;--xf-sheet:#433126;--xf-line:#715b48;--xf-ink:#fcfbee;--xf-muted:#d8d3bb;--xf-accent:#f8d6a8;--xf-hover:#574236;color-scheme:dark}
@media(max-width:999px){.xf-stage .xf-top{grid-template-columns:1fr auto;gap:8px 16px;padding:12px 16px}.xf-stage .xf-scene{grid-column:1/-1;grid-row:2;justify-content:flex-start;font-size:12px;gap:4px 12px}.xf-stage .xf-brand h1{font-size:20px}.xf-stage .xf-brand small{display:none}.xf-stage .xf-owner{width:32px;height:32px}.xf-stage .xf-toggle{padding-inline:12px}}
@media(min-width:640px){.xf-stage .xf-dialog{left:auto;right:16px;width:min(480px,calc(100% - 32px))}}
@media(prefers-reduced-motion:reduce){.xf-stage *{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
`;

export default function XiaofanguanStage(){
  const state=useSRStateAPI();
  const {connected}=useSRStageSnapshot();
  const [values,setValues]=React.useState<Record<string,unknown>|null>(null);
  const [loading,setLoading]=React.useState(true),[error,setError]=React.useState(false),[retry,setRetry]=React.useState(0);
  const [wide,setWide]=React.useState(()=>window.matchMedia(wideQuery).matches);
  const [open,setOpen]=React.useState(()=>window.matchMedia(wideQuery).matches);
  const [tab,setTab]=React.useState('now');
  const dialog=React.useRef<HTMLDialogElement>(null),toggle=React.useRef<HTMLButtonElement>(null);
  const dialogId=React.useId();
  const portrait=useSRAssetUrl('sr-asset://assets/images/keeper.jpg');
  const [portraitFailed,setPortraitFailed]=React.useState(false);
  React.useEffect(()=>setPortraitFailed(false),[portrait]);

  React.useEffect(()=>{
    const media=window.matchMedia(wideQuery);
    const change=()=>{setWide(media.matches);setOpen(media.matches);};
    media.addEventListener('change',change);change();return()=>media.removeEventListener('change',change);
  },[]);
  React.useEffect(()=>{
    let disposed=false,revision=0,timer:ReturnType<typeof setTimeout>;
    const refresh=()=>{
      const ticket=++revision;clearTimeout(timer);
      timer=setTimeout(async()=>{
        setLoading(true);
        try{
          const entries=await state.batchGetState(roots.map(path=>({path,scope:'message' as const})));
          if(disposed||ticket!==revision)return;
          if(roots.some(root=>!entries.some(entry=>entry.path===root&&entry.value!==undefined)))throw Error('状态根缺失');
          setValues(Object.fromEntries(entries.map(entry=>[entry.path,entry.value])));setError(false);
        }catch{if(!disposed&&ticket===revision)setError(true);}
        finally{if(!disposed&&ticket===revision)setLoading(false);}
      },0);
    };
    const offState=state.subscribe(event=>{if(event.data.scope==='message'&&(!event.data.path||roots.includes(event.data.path.split('.')[0])))refresh();});
    refresh();
    return()=>{disposed=true;revision++;clearTimeout(timer);offState();};
  },[state,connected,retry]);
  React.useEffect(()=>{
    const node=dialog.current;if(!node||wide||!open)return;
    node.showModal();return()=>{if(node.open)node.close();};
  },[open,wide]);
  const close=()=>{dialog.current?.close();setOpen(false);toggle.current?.focus();};
  const props={values,tab,onTab:setTab,loading,error,connected,retry:()=>setRetry(n=>n+1)};
  return <div className="xf-stage">
    <style>{css}</style>
    <header className="xf-top"><div className="xf-brand"><span className="xf-owner">{portrait&&!portraitFailed?<img src={portrait} alt="掌柜" onError={()=>setPortraitFailed(true)}/>:<span role="img" aria-label="掌柜头像暂不可用">掌</span>}</span><div><h1>小饭馆</h1><small>灶火正暖 · 日子慢慢过</small></div></div><HouseholdPanel {...props} view="summary"/><button ref={toggle} className="xf-toggle" type="button" aria-expanded={open} aria-controls={dialogId} onClick={()=>setOpen(value=>!value)}>{open?'收起家常簿':'翻开家常簿'}</button></header>
    <div className="xf-layout" data-docked={wide&&open}><section className="xf-reading" aria-label="小饭馆的故事"><SR.WorldStory showState={false}/></section>{wide&&open&&<aside id={dialogId} className="xf-side" aria-label="家常簿"><HouseholdPanel {...props}/></aside>}</div>
    {!wide&&open&&<dialog id={dialogId} ref={dialog} className="xf-dialog" aria-label="家常簿" onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target===event.currentTarget){const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}}}><div className="xf-dialog-close"><button type="button" autoFocus onClick={close}>收起家常簿</button></div><HouseholdPanel {...props}/></dialog>}
  </div>;
}
