import type {StateDefinition} from './api/worlds';
import styles from './WorldDetailPage.module.css';

function Value({value,depth=0}:{value:unknown;depth?:number}){
  if(value!==null&&typeof value==='object'){
    const entries=Object.entries(value);
    return <details className={styles.valueTree} open={depth===0}><summary>{Array.isArray(value)?`数组 · ${entries.length} 项`:`对象 · ${entries.length} 项`}</summary>
      {entries.map(([key,child])=><div className={styles.valueBranch} key={key}><span>{key}</span><Value value={child} depth={depth+1}/></div>)}
    </details>;
  }
  return <span className={styles.valueText}>{typeof value==='string'?value:JSON.stringify(value)??'未设置'}</span>;
}
export function StateItems({items,overrides}:{items:Record<string,StateDefinition>;overrides?:Record<string,unknown>}){
  return <div className={styles.stateItems}>{Object.entries(items).map(([name,item])=>{
    const overridden=overrides!==undefined&&Object.hasOwn(overrides,name);
    return <article className={styles.stateItem} key={name}>
      <div className={styles.stateItemHead}><strong>{name}</strong><span className={styles.stateType}>{({string:'文本',number:'数字',boolean:'布尔',json:'JSON'} as Record<string,string>)[item.type]??item.type}</span>{overrides!==undefined&&<span className={styles.stateSource}>{overridden?'开局覆盖':'世界默认'}</span>}</div>
      {item.description&&<p className={styles.stateDescription}>{item.description}</p>}
      {item.type==='number'&&(item.min!==undefined||item.max!==undefined)&&<p className={styles.stateDescription}>范围：{item.min??'不限'} ～ {item.max??'不限'}</p>}
      <div className={styles.stateValue}><span className={styles.valueLabel}>{overrides!==undefined?'初始值':'默认值'}</span><Value value={overridden?overrides[name]:item.initial}/></div>
    </article>;
  })}</div>;
}
export function WorldState({scopes}:{scopes:Record<string,Record<string,StateDefinition>>}){
  const groups=(['global','session','message'] as const).filter(scope=>Object.keys(scopes[scope]??{}).length>0);
  if(!groups.length)return <p>这个世界没有声明状态。</p>;
  return <><p className={styles.stateIntro}>这里展示世界卡声明的状态和默认值。</p>{groups.map(scope=><section key={scope} className={styles.stateGroup}><div className={styles.stateGroupHeading}><h3>{({global:'全局状态',session:'会话状态',message:'消息状态'})[scope]}</h3><span>{({global:'在世界中共享',session:'每个会话独立',message:'可由开局覆盖'})[scope]}</span></div><StateItems items={scopes[scope]}/></section>)}</>;
}
