import {MessageCircle} from 'lucide-react';
import type {World} from '../../fixtures/worlds';
import {sessionSamples} from '../../fixtures/sessions';
import styles from './WorldLibraryPage.module.css';
export function WorldCard({world,onClick}:{world:World;onClick:()=>void}){
  return <button className={styles.card} type="button" onClick={onClick} aria-label={'查看世界卡：'+world.title}>
    <img className={styles.cover} src={world.cover} alt="" loading="eager"/>
    <span className={styles.cardScrim} aria-hidden="true"/>
    <span className={styles.cardText}>
      <strong className={styles.cardTitle} title={world.title}>{world.title}</strong>
      <span className={styles.cardGenre} title={world.genre}>{world.genre}</span>
      <span className={styles.cardCount}><MessageCircle size={14} strokeWidth={1.8} aria-hidden="true"/>{sessionSamples.filter(session=>session.worldId===world.id).length} 个会话</span>
    </span>
  </button>;
}
