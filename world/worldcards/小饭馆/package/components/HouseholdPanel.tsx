import React from 'react';
import {useSRAssetUrl} from '@sillyrealms/sdk';

// Rules guide the model; nested JSON types are not enforced by the schema.
// Never turn a malformed value into a plausible story fact.
type RecordValue = Record<string, unknown>;
type Props = {values:RecordValue|null; view?:'summary'|'book'; tab:string; onTab:(tab:string)=>void; loading:boolean; error:boolean; connected:boolean; retry:()=>void};
const object=(value:unknown):RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:{};
const text=(value:unknown,fallback='未交代')=>typeof value==='string'&&value.trim()?value:fallback;
const list=(value:unknown)=>Array.isArray(value)?value:null;

function Empty({children}:{children:React.ReactNode}){return <p className="xf-empty">{children}</p>;}
function Rows({value,empty,children}:{value:unknown;empty:string;children:(row:RecordValue,index:number)=>React.ReactNode}){
  const rows=list(value);
  if(!rows)return <Empty>这页暂时没记清。</Empty>;
  if(!rows.length)return <Empty>{empty}</Empty>;
  return <div className="xf-rows">{rows.map((value,index)=>{
    const row=object(value);
    return <React.Fragment key={typeof row.id==='string'&&rows.filter(item=>object(item).id===row.id).length===1?row.id:index}>{Object.keys(row).length?children(row,index):<Empty>这条记录暂时没记清。</Empty>}</React.Fragment>;
  })}</div>;
}

function Portrait({name,path}:{name:string;path:string}){
  const src=useSRAssetUrl(path);
  const [failed,setFailed]=React.useState(false);
  React.useEffect(()=>setFailed(false),[src]);
  return <span className="xf-avatar">{src&&!failed?<img src={src} alt={name} onError={()=>setFailed(true)}/>:<span role="img" aria-label={name+'头像暂不可用'}>{name.slice(-2,-1)}</span>}</span>;
}

function Person({name,value,path}:{name:string;value:unknown;path:string}){
  const person=object(value);
  return <details className="xf-person">
    <summary><Portrait name={name} path={path}/><span className="xf-person-copy"><strong>{name}</strong><span>{text(person.activity,'近况尚未交代')}</span></span><span className="xf-disclosure" aria-hidden="true">＋</span></summary>
    <dl className="xf-person-detail"><div><dt>人在何处</dt><dd>{text(person.place)}</dd></div><div><dt>眼下神情</dt><dd>{text(person.mood)}</dd></div></dl>
  </details>;
}

export default function HouseholdPanel({values,view='book',tab,onTab,loading,error,connected,retry}:Props){
  const scene=object(values?.scene),family=object(values?.family),kitchen=object(values?.kitchen);
  const day=typeof scene.day==='number'&&Number.isInteger(scene.day)&&scene.day>0?`第${scene.day}日`:'';
  if(view==='summary')return <div className="xf-scene" aria-label="当前光景">
    <span>{values?text(scene.period):loading?'正翻开家常簿…':'光景尚未载入'}</span>
    {values&&<><span>{text(scene.place)}</span><span>{text(scene.business)}</span>{typeof scene.occupiedTables==='number'&&Number.isInteger(scene.occupiedTables)&&scene.occupiedTables>=0&&<span>{scene.occupiedTables===0?'堂内暂无客人':`堂内 ${scene.occupiedTables} 桌`}</span>}</>}
    {!connected&&<span className="xf-connection">暂未连上</span>}
  </div>;
  return <div className="xf-book">
    <div className="xf-book-title"><div><span className="xf-eyebrow">柴米油盐，都在这里</span><h2>家常簿</h2></div><span className="xf-book-day">{day}<small>当前记载</small></span></div>
    <div className="xf-book-tabs" role="group" aria-label="家常簿栏目">{[['now','眼下'],['kitchen','灶间'],['ledger','小账']].map(([key,label])=><button key={key} type="button" aria-pressed={tab===key} onClick={()=>onTab(key)}>{label}</button>)}</div>
    <div className="xf-book-content" aria-busy={loading}>
      {!connected&&<p className="xf-notice" role="status">连接暂时中断，保留上次记载。</p>}
      {error&&<p className="xf-notice" role="alert">家常簿暂时没能读到。<button type="button" onClick={retry} disabled={loading}>重新翻开</button></p>}
      {!values?<Empty>{loading?'正在读取家常簿…':'尚未取得当前记载。'}</Empty>:<>
        {tab==='now'&&<>
          <section className="xf-book-section"><h3>这一家子</h3><Person name="李鱼儿" value={family.yuer} path="sr-asset://assets/images/li-yuer.jpg"/><Person name="李鸟儿" value={family.niaoer} path="sr-asset://assets/images/li-niaoer.jpg"/></section>
          <section className="xf-book-section"><h3>家里惦记的事</h3><Rows value={values.wishes} empty="还没有记下新的挂念。">{row=><article className="xf-wish"><div className="xf-row-heading"><span>{text(row.owner)}</span><span className="xf-stamp">{text(row.status)}</span></div><p>{text(row.content,'这件事尚未记清')}</p><small>{text(row.progress,'进展尚未交代')}</small></article>}</Rows></section>
          <section className="xf-book-section xf-weather"><h3>窗外光景</h3><p>{text(scene.weather,'天气尚未交代')}</p><small>日子跟着故事走，闲谈不催人。</small></section>
        </>}
        {tab==='kitchen'&&<>
          <section className="xf-book-section"><h3>客官点的菜</h3><Rows value={kitchen.orders} empty="还没记下待做的点单。">{row=><article className="xf-order"><h4>{text(row.guest,'食客')}</h4><Rows value={row.items} empty="菜品尚未交代。">{item=><div className="xf-order-item"><span>{text(item.name)}<small>{text(item.amount)}</small></span><span className="xf-stamp" data-done={item.status==='已上桌'}>{text(item.status)}</span></div>}</Rows></article>}</Rows></section>
          <details className="xf-fold" open><summary>灶边的食材</summary><Rows value={kitchen.stock} empty="食材还未盘点，不代表没有。">{row=><div className="xf-stock"><div className="xf-row-heading"><strong>{text(row.name)}</strong><span>{text(row.amount,'未盘点')}</span></div><small>{text(row.condition)}</small></div>}</Rows></details>
          <details className="xf-fold"><summary>做菜的心得</summary><Rows value={values.recipes} empty="还没有记下做菜心得。">{row=><article className="xf-recipe"><div className="xf-row-heading"><h4>{text(row.name)}</h4><span className="xf-stamp">{text(row.stage)}</span></div><p>{text(row.notes,'做法尚未记下')}</p><small>{text(row.feedback,'还未听到试菜反馈')}</small></article>}</Rows></details>
        </>}
        {tab==='ledger'&&<>
          <section className="xf-book-section"><h3>近来的一笔笔</h3><p className="xf-explanation">只记已经发生的收支，家底还未盘点。</p><Rows value={values.ledger} empty="尚未记下收支。菜价涨跌不算一笔买卖。">{row=><article className="xf-transaction"><div className="xf-row-heading"><span>{text(row.kind)}</span><strong>{text(row.amount,'金额未交代')}</strong></div><p>{text(row.subject,'事项尚未记清')}</p><small>{typeof row.day==='number'&&Number.isInteger(row.day)&&row.day>0?`第${row.day}日`:'日期未交代'}</small></article>}</Rows></section>
          <details className="xf-fold" open><summary>熟面孔</summary><Rows value={values.neighbors} empty="街坊的名字和口味，慢慢熟起来再记。">{row=><article className="xf-neighbor"><h4>{text(row.name,'未具名的街坊')}</h4><small>{text(row.role)}</small><p>口味：{text(row.preference)}</p><p>{text(row.lastTopic,'还没有记下闲谈')}</p></article>}</Rows></details>
        </>}
      </>}
      <p className="xf-book-end">饭要趁热，日子慢慢来。</p>
    </div>
  </div>;
}
