import type {Presentation} from '@sillyrealms/sdk/presentation';
import {WorldDocumentRenderer} from '@sillyrealms/sdk/world-document';
import {resolvePresentation} from './presentation';

/** Component presentations are mounted by the detail's persistent preview pool. */
export function WorldPresentation({presentation,title,emptyText,fallbackText}:{
  presentation:Presentation|null|undefined;title:string;emptyText?:string;fallbackText?:string;
}) {
  const value=resolvePresentation(presentation,fallbackText);
  if(!value)return emptyText?<p>{emptyText}</p>:null;
  return value.type==='markdown'?<WorldDocumentRenderer showStyleWarning={false} title={title} content={value.text}/>:null;
}
