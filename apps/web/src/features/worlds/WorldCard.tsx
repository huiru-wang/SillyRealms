import {MessageCircle} from 'lucide-react';
import type {WorldListItem} from './api/worlds';
import styles from './WorldLibraryPage.module.css';
import {WorldAssetImage} from '../../world-assets';
export function WorldCard({world,onClick}:{world:WorldListItem;onClick:()=>void}){
  const tags=world.tags.join(' · ');
  return <button className={styles.card} type="button" onClick={onClick} aria-label={'查看世界卡：'+world.name}>
    <WorldAssetImage className={styles.cover} source={world.cover} worldId={world.id} alt="" loading="lazy"/>
    <span className={styles.cardScrim} aria-hidden="true"/>
    <span className={styles.cardText}>
      <strong className={styles.cardTitle} title={world.name}>{world.name}</strong>
      {tags&&<span className={styles.cardGenre} title={tags}>{tags}</span>}
      <span className={styles.cardCount}><MessageCircle size={14} strokeWidth={1.8} aria-hidden="true"/>{world.sessionCount} 个会话</span>
    </span>
  </button>;
}
