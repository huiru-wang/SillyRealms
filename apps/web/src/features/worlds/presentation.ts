import type {Presentation} from '@sillyrealms/sdk/presentation';

/** Only the opening caller supplies public prose as a missing-preview fallback. */
export function resolvePresentation(presentation:Presentation|null|undefined, fallbackText?:string):Presentation|null {
  return presentation??(fallbackText===undefined?null:{type:'markdown',text:fallbackText});
}
