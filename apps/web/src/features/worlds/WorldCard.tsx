import {useTranslation} from 'react-i18next';
import {MessageCircle} from 'lucide-react';
import type {WorldListItem} from './api/worlds';
import styles from './WorldLibraryPage.module.css';
import {useManagement} from '../../app/ManagementData';
import {WorldCover} from './WorldCover';
export function WorldCard({world,onClick}:{world:WorldListItem;onClick:()=>void}){
  const {t} = useTranslation('worlds');
  const {coverMosaicDensity}=useManagement();
  const tags=world.tags.join(' · ');
  return <button className={styles.card} type="button" onClick={onClick} aria-label={t('worlds:viewWorld',{name:world.name})}>
    <WorldCover className={styles.cover} source={world.cover} worldId={world.id} mosaicEnabled={world.coverMosaicEnabled} density={coverMosaicDensity}/>
    <span className={styles.cardScrim} aria-hidden="true"/>
    <span className={styles.cardText}>
      <strong className={styles.cardTitle} title={world.name}>{world.name}</strong>
      {tags&&<span className={styles.cardGenre} title={tags}>{tags}</span>}
      <span className={styles.cardCount}><MessageCircle size={14} strokeWidth={1.8} aria-hidden="true"/>{t('worlds:sessionCount',{count:world.sessionCount})}</span>
    </span>
  </button>;
}
