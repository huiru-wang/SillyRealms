import {MessageCircle} from 'lucide-react';
import {safeImage,type WorldListItem} from './api/worlds';
import styles from './WorldLibraryPage.module.css';
export function WorldCard({world,onClick}:{world:WorldListItem;onClick:()=>void}){
  const cover=safeImage(world.cover),tags=world.tags.map(tag=>tag.name).join(' · ');
  return <button className={styles.card} type="button" onClick={onClick} aria-label={'查看世界卡：'+world.name}>
    {cover&&<img className={styles.cover} src={cover} alt="" loading="lazy"/>}
    <span className={styles.cardScrim} aria-hidden="true"/>
    <span className={styles.cardText}>
      <strong className={styles.cardTitle} title={world.name}>{world.name}</strong>
      {tags&&<span className={styles.cardGenre} title={tags}>{tags}</span>}
      <span className={styles.cardCount}><MessageCircle size={14} strokeWidth={1.8} aria-hidden="true"/>{world.sessionCount} 个会话</span>
    </span>
  </button>;
}
