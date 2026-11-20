import React from 'react';
import {SR,useSRState} from '@sillyrealms/sdk';
import Styles from './Styles';
import Assets from './Assets';
import Clues from './Clues';
const names=['','第一幕 · 寻尸','第二幕 · 事件','第三幕 · 修罗道','终局 · 选择','案后 · 复盘'];
function Evidence({id}){
 const [rotated,setRotated]=React.useState(false);const [failed,setFailed]=React.useState(false);
 const clue=Clues.data.find(c=>c.id===id);
 if(!clue)return <p role="status">证据 {String(id)} 尚无可用卡面，请在对话中核对记录。</p>;
 const src=id==='08'?Assets.data['线索08-一般']:id==='08-hard'?Assets.data['线索08-困难']:null;
 return <details><summary>{clue.number!==null?'#'+clue.number+' · ':''}{clue.title}</summary><div><p className="evidence">{clue.text}</p>{src&&(failed?<p role="alert">图像未能载入，可在交付目录查看同名原图。</p>:<><img className={'clue-image'+(rotated?' rotated':'')} src={src} alt={clue.title+'原始卡面'} onError={()=>setFailed(true)}/><button type="button" aria-pressed={rotated} onClick={()=>setRotated(!rotated)}>旋转图像 180°</button></>)}<small className="source">{clue.source}</small></div></details>
}
export default function ForumStage(){
 const [chapter]=useSRState('chapter',1);const [progress]=useSRState('progress',{});const [publicClues]=useSRState('publicClues',[]);const [privateClues]=useSRState('privateClues',[]);const [notes]=useSRState('notes',[]);const [ledger]=useSRState('ledger',{});
 const [open,setOpen]=React.useState(false),[view,setView]=React.useState('evidence'),[zoom,setZoom]=React.useState(false),[failed,setFailed]=React.useState(false);
 const toggle=React.useRef(null),panel=React.useRef(null);
 React.useEffect(()=>{if(open)panel.current?.focus()},[open]);
 const close=()=>{setOpen(false);toggle.current?.focus()};
 const safeIds=value=>Array.isArray(value)?[...new Set(value.filter(x=>typeof x==='string'))]:[];
 const exposed=safeIds(publicClues),privateIds=safeIds(privateClues).filter(id=>!exposed.includes(id));
 const route=Array.isArray(progress?.route)?progress.route.filter(x=>typeof x==='number'):[];
 const draws=Array.isArray(ledger?.draws?.__PLAYER_ID__)?ledger.draws.__PLAYER_ID__.length:0;
 return <div className="wf wf-stage" data-window-stage><Styles/><header><div><h1>宁温河馨</h1><p className="meta">__PLAYER_NAME__ · {names[Number(chapter)]??'当前阶段待核对'} · 2016.02.01</p></div><button ref={toggle} type="button" aria-controls="casebook" aria-expanded={open} onClick={()=>open?close():setOpen(true)}>调查手册</button></header><div className={"workspace"+(open?" has-panel":"")}><main className="story-slot"><SR.WorldStory showState={false}/></main>{open&&<aside className="casebook" id="casebook" ref={panel} tabIndex={-1} aria-label="调查手册" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();close()}}}><div className="row"><h2>调查手册</h2><button type="button" onClick={close}>返回对话</button></div><p className="muted">当前已提交记录 · 仅展示你已知的内容</p><div className="tools row" role="group" aria-label="手册内容">{[['evidence','线索'],['map','地图'],['notes','记录']].map(([id,label])=><button key={id} type="button" aria-pressed={view===id} onClick={()=>setView(id)}>{label}</button>)}</div>
{view==='evidence'&&<section><h3>已公开 · {exposed.length}</h3>{exposed.length?exposed.map(id=><Evidence key={id} id={id}/>):<p className="empty muted">尚未公开线索。可以在对话中开始调查。</p>}<h3 style={{marginTop:24}}>仅你可见 · {privateIds.length}</h3>{privateIds.length?privateIds.map(id=><Evidence key={id} id={id}/>):<p className="empty muted">暂无私密线索。你的角色经历在开局正文中。</p>}<p className="muted">公开、隐藏或申请搜证，请在对话中说明。</p></section>}
{view==='map'&&<section className="flow"><h3>宁河城原地图</h3><p className="muted">地点编号与线索编号不同。双短线为环线出入口。</p><button type="button" aria-pressed={zoom} onClick={()=>setZoom(!zoom)}>{zoom?'适合宽度':'放大地图'}</button>{failed?<p role="alert">地图载入失败，请查看原始素材中的地图.jpg。</p>:<div className={'map-view'+(zoom?' zoom':'')} tabIndex={0} aria-label="原地图，可滚动"><img src={Assets.data['宁河城地图']} alt="宁河城环线地图，标有1至37号地点、施工区、河道与图例；可放大查看。" onError={()=>setFailed(true)}/></div>}<p>已确认地点：{route.length?route.join(' → '):'尚未记录'}</p><p className="muted">考虑时间、路线和隐蔽性，提出下一处地点及理由。</p></section>}
{view==='notes'&&<section className="flow"><h3>当前进度</h3><p>{names[Number(chapter)]??'待核对'} · {progress?.difficulty==='hard'?'困难':'一般'}难度</p><div className="ledger"><p>本阶段已抽人物卡：{draws} / 4</p><p>你的私聊：{Array.isArray(ledger?.privateUsed)&&ledger.privateUsed.includes('__PLAYER_ID__')?'已使用':'尚未使用'}</p><p>你的屏蔽机会：{Array.isArray(ledger?.blockUsed)&&ledger.blockUsed.includes('__PLAYER_ID__')?'已使用':'尚未使用'}</p></div><h3>事实与假设</h3>{Array.isArray(notes)&&notes.length?<ul>{notes.filter(x=>typeof x==='string').map((note,i)=><li key={i}>{note}</li>)}</ul>:<p className="muted">还没有笔记。可以在对话中说“记下这条假设”，并继续寻找支持或反驳它的证据。</p>}<p className="muted">这里显示最近提交的状态。若一轮失败或被停止，以对话中的运行提示为准。</p></section>}
</aside>}</div></div>
}
