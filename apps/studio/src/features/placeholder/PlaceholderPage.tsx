import {ArrowLeft,LayoutTemplate} from 'lucide-react';
import {Link} from 'react-router-dom';
import styles from './PlaceholderPage.module.css';
export function PlaceholderPage({title,description}:{title:string;description:string}){
  const isMoreDetail=title==='模型配置'||title==='设置';
  return <div className={styles.page}>
    {isMoreDetail&&<Link className={styles.mobileBack} to="/more" aria-label="返回更多"><ArrowLeft size={20}/></Link>}
    <h1>{title}</h1>
    <section className={styles.panel}>
      <LayoutTemplate size={30} strokeWidth={1.5}/>
      <h2>页面设计进行中</h2>
      <p>{description}</p>
      <Link className={isMoreDetail?styles.desktopReturn:undefined} to="/worlds"><ArrowLeft size={16}/>返回世界卡首页</Link>
    </section>
  </div>;
}
