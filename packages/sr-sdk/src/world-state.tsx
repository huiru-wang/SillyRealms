import React,{createContext,useContext,useLayoutEffect,useMemo,useRef} from 'react';
import {useTranslation} from 'react-i18next';
import type {StateValue} from './state-contract.js';
import {localizeDocumentTasks,renderWorldDocument} from './world-document/render.js';
import {useSRAssetBaseUrl} from './asset-context.js';
export type WorldStateQuery={path:string;scope?:'global'};
/** Detail components have queries only. No implicit subscriptions or state mutations. */
export interface SRWorldStateAPI {
  getState(path:string,scope?:'global'):Promise<StateValue|undefined>;
  batchGetState(entries:WorldStateQuery[]):Promise<Array<{path:string;scope:'global';value:StateValue|undefined}>>;
}
export const WorldStateContext=createContext<SRWorldStateAPI|null>(null);
export function useSRWorldStateAPI():SRWorldStateAPI {
  const value=useContext(WorldStateContext);
  if(!value)throw Error('World state API unavailable in this context');
  return value;
}
/** Scriptless prose inside the already isolated creator document; retains safe author styles. */
export function WorldDocumentContent({content}:{content:string}) {
  const {t}=useTranslation('stage');
  const container=useRef<HTMLDivElement>(null);
  const assetBaseUrl=useSRAssetBaseUrl();
  const rendered=useMemo(()=>renderWorldDocument(content,{profile:'document',assetBaseUrl}),[content,assetBaseUrl]);
  useLayoutEffect(()=>{if(container.current)localizeDocumentTasks(container.current,t('document.taskComplete'),t('document.taskIncomplete'));},[rendered,t]);
  return <>{rendered.assetErrors.length>0&&<small role="status" title={rendered.assetErrors.join('; ')}>{t('document.invalidAsset')}</small>}<div ref={container} dangerouslySetInnerHTML={{__html:rendered.head+rendered.html}}/></>;
}
