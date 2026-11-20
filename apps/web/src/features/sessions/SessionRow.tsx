import type {ReactNode} from 'react';
import {Link} from 'react-router-dom';
import styles from './SessionRow.module.css';
import {WorldAssetImage} from '../../world-assets';

export function SessionRow({id,worldId,title,updatedAt,cover,actions}:{id:string;worldId:string;title?:string|null;updatedAt:string|number;cover?:string|null;actions:ReactNode}){
 const name=title||'未命名会话',date=new Date(updatedAt),full=date.toLocaleString();
 return <div className={styles.row} data-session-row>
  <Link className={styles.link} to={'/sessions/'+encodeURIComponent(id)}>
   {cover&&<WorldAssetImage className={styles.cover} source={cover} worldId={worldId} alt=""/>}
   <strong className={styles.title} title={name}>{name}</strong>
   <time className={styles.updated} dateTime={date.toISOString()} title={'更新于 '+full} aria-label={'更新于 '+full}>
    <span className={styles.fullDate}>更新于 {full}</span><span className={styles.shortDate}>{date.toLocaleDateString()}</span>
   </time>
  </Link>
  <div className={styles.actions} data-session-actions>{actions}</div>
 </div>;
}
