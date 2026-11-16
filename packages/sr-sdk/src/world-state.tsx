import React,{createContext,useContext,useMemo} from 'react';
import type {StateValue} from './state-contract.js';
import {renderWorldDocument} from './world-document/render.js';
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
  const assetBaseUrl=useSRAssetBaseUrl();
  const rendered=useMemo(()=>renderWorldDocument(content,{profile:'document',assetBaseUrl}),[content,assetBaseUrl]);
  return <>{rendered.assetErrors.length>0&&<small role="status">{rendered.assetErrors.join('；')}</small>}<div dangerouslySetInnerHTML={{__html:rendered.head+rendered.html}}/></>;
}
