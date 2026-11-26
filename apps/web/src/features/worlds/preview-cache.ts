import type {Presentation} from '@sillyrealms/sdk/presentation';
import type {WorldDetail} from './api/worlds';

export type PreviewEntry={id:string;entry:string;title:string;surface?:'dialog'};

export function presentationPreview(presentation:Presentation|null|undefined,id:string,title:string,surface?:'dialog'):PreviewEntry|null {
  return presentation?.type==='component'?{id,entry:presentation.component,title,...(surface?{surface}:{})}:null;
}
export type PreviewModules={code:Record<string,string>;errors:Record<string,string>};
export const PREVIEW_LIMIT=10;

export function previewContentIdentity(world:Pick<WorldDetail,'id'|'components'|'publication'>):string {
  return JSON.stringify([world.id,world.publication.release.version,world.components??[]]);
}

/** First opened, first evicted. Revisiting or retrying never promotes an entry. */
export function retainPreview(entries:readonly PreviewEntry[],active:PreviewEntry|null):readonly PreviewEntry[] {
  if(!active)return entries;
  const index=entries.findIndex(item=>item.id===active.id);
  if(index<0)return [...entries.slice(-(PREVIEW_LIMIT-1)),active];
  const previous=entries[index];
  if(previous.entry===active.entry&&previous.title===active.title&&previous.surface===active.surface)return entries;
  return entries.map((item,i)=>i===index?active:item);
}

/** One detail-page lifetime; individual frames never own the shared request. */
export function createPreviewSourceCache(load:(signal:AbortSignal)=>Promise<PreviewModules>) {
  let current:Promise<PreviewModules>|undefined;
  const controllers=new Set<AbortController>();
  return {
    read(refresh=false):Promise<PreviewModules> {
      if(current&&!refresh)return current;
      const controller=new AbortController();controllers.add(controller);
      const result=Promise.resolve().then(()=>{
        controller.signal.throwIfAborted();
        return load(controller.signal);
      }).then(value=>{controller.signal.throwIfAborted();return value;});
      current=result;
      const forget=()=>{if(current===result)current=undefined;};
      void result.then(value=>{
        controllers.delete(controller);
        if(Object.keys(value.errors).length)forget();
      },()=>{controllers.delete(controller);forget();});
      return result;
    },
    dispose(){
      current=undefined;
      for(const controller of controllers)controller.abort();
      controllers.clear();
    },
  };
}
