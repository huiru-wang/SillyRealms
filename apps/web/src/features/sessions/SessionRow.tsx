import {useTranslation} from 'react-i18next';
import {i18n} from '../../i18n/instance.ts';
import type {ReactNode} from 'react';
import {Link} from 'react-router-dom';
import styles from './SessionRow.module.css';
import {WorldAssetImage} from '../../world-assets';

export function SessionRow({id,worldId,title,updatedAt,cover,actions}:{id:string;worldId:string;title?:string|null;updatedAt:string|number;cover?:string|null;actions:ReactNode}){
  useTranslation();
 const name=title||i18n.t("common:untitledSession"),date=new Date(updatedAt),full=date.toLocaleString(i18n.resolvedLanguage);
 return <div className={styles.row} data-session-row>
  <Link className={styles.link} to={'/sessions/'+encodeURIComponent(id)}>
   {cover&&<WorldAssetImage className={styles.cover} source={cover} worldId={worldId} alt=""/>}
   <strong className={styles.title} title={name}>{name}</strong>
   <time className={styles.updated} dateTime={date.toISOString()} title={i18n.t("sessions:updatedAtDate",{date:full})} aria-label={i18n.t("sessions:updatedAtDate",{date:full})}>
    <span className={styles.fullDate}>{i18n.t("sessions:updatedAtDate",{date:full})}</span><span className={styles.shortDate}>{date.toLocaleDateString(i18n.resolvedLanguage)}</span>
   </time>
  </Link>
  <div className={styles.actions} data-session-actions>{actions}</div>
 </div>;
}
