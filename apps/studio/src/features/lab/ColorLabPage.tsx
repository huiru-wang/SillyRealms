import {useState} from 'react';
import {Palette} from 'lucide-react';
import {Link} from 'react-router-dom';
import styles from './ColorLabPage.module.css';
const palettes=[
  {key:'default',name:'石墨紫 · 默认',desc:'贴近本轮原型的低饱和石墨紫'},
  {key:'neutral',name:'中性墨黑',desc:'减少紫色环境光，降低背景的视觉存在感'},
  {key:'cool',name:'冷灰蓝紫',desc:'保留材质层次，增加冷调的专业感'},
] as const;
export function ColorLabPage(){
  const [current,setCurrent]=useState(()=>{
    try{return localStorage.getItem('sr-studio-palette')||'default'}catch{return 'default'}
  });
  function select(v:string){setCurrent(v);document.documentElement.dataset.palette=v;try{localStorage.setItem('sr-studio-palette',v)}catch{}}
  return <div className={styles.page}>
    <div className={styles.eyebrow}><Palette size={17}/>视觉实验室 · 仅改变颜色变量，不修改页面布局</div>
    <h1>Color Lab</h1>
    <p>以下色调仍是设计候选。切换后返回世界卡首页，比较真实界面中的文字、选中态、边框、封面和环境层次。</p>
    <div className={styles.choices}>{palettes.map(p=><button className={[styles.choice,current===p.key?styles.active:''].join(' ')} key={p.key} onClick={()=>select(p.key)}>
      <strong>{p.name}</strong><span>{p.desc}</span><span className={styles.swatches}><i/><i/><i/><i/></span>
    </button>)}</div>
    <Link className={styles.back} to="/worlds">返回世界卡首页</Link>
  </div>;
}
