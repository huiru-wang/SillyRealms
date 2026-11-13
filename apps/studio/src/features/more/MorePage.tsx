import {Box,ChevronRight,Moon,Sun} from 'lucide-react';
import {Link,useOutletContext} from 'react-router-dom';
import type {Theme} from '../../hooks/useTheme';
import styles from './MorePage.module.css';
export function MorePage(){
  const {theme,toggleTheme}=useOutletContext<{theme:Theme;toggleTheme:()=>void}>();
  return <section className={styles.page}><h1>更多</h1>
    <div className={styles.group}><h2>外观</h2><div className={styles.row}><span className={styles.label}>{theme==='dark'?<Moon size={19}/>:<Sun size={19}/>}主题</span><div className={styles.theme} role="group" aria-label="主题"><button aria-pressed={theme==='light'} onClick={()=>{if(theme!=='light')toggleTheme();}}>浅色</button><button aria-pressed={theme==='dark'} onClick={()=>{if(theme!=='dark')toggleTheme();}}>深色</button></div></div></div>
    <div className={styles.group}><h2>配置</h2><Link className={styles.row} to="/models"><span className={styles.label}><Box size={19}/>模型</span><ChevronRight size={18} aria-hidden="true"/></Link></div>
  </section>;
}
