import {ArrowLeft,LayoutTemplate} from 'lucide-react';
import {Link} from 'react-router-dom';
import styles from './PlaceholderPage.module.css';
export function PlaceholderPage({title,description}:{title:string;description:string}){
  return <div className={styles.page}>
    <h1>{title}</h1>
    <section className={styles.panel}>
      <LayoutTemplate size={30} strokeWidth={1.5}/>
      <h2>页面设计进行中</h2>
      <p>{description}</p>
      <Link to="/worlds"><ArrowLeft size={16}/>返回世界卡首页</Link>
    </section>
  </div>;
}
