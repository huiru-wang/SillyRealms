import {compareReleaseVersion} from '@sillyrealms/sdk/release-version';
import {api,ApiError,json} from '../../api.ts';
import type {HttpRequest} from '../../transport/http.ts';
import type {WorldDetail,WorldPublication,WorldVersionsView,WorldVersionSummary,WorldVersionApplication} from './api/worlds.ts';

export function releaseDirection(current:string|null|undefined,target:string):'upgrade'|'downgrade'|'current'|null {
  if(!current)return null;
  try{const order=compareReleaseVersion(target,current);return order>0?'upgrade':order<0?'downgrade':'current';}
  catch{return null;}
}
export function hasWorldUpdate(world:Partial<WorldVersionSummary>):boolean {
  return !!world.latestVersion&&releaseDirection(world.currentVersion,world.latestVersion)==='upgrade';
}
/** Installed content changes independently of management edits and update checks. */
export function worldReleaseIdentity(world:{id:string;publication?:WorldPublication|null;currentVersion?:string|null}):string {
  return JSON.stringify([world.id,world.publication?.release.version??world.currentVersion??null]);
}
export function publicationLink(value:string|undefined):string|undefined {
  if(!value)return undefined;
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}
  catch{return undefined;}
}

export type WorldVersionsState={
  view:WorldVersionsView|null;loading:boolean;refreshing:boolean;applying:string|null;error:unknown|null;
};
type Options={
  request?:HttpRequest;
  onSummary:(view:WorldVersionsView)=>void;
  onApplied:(world:WorldDetail)=>void;
};
/** No requests on construction: opening reads local data; only refresh POST visits the release source. */
export function createWorldVersionsController(worldId:string,options:Options){
  const request=options.request??api,base='v1/worlds/'+encodeURIComponent(worldId);
  const listeners=new Set<()=>void>();
  const requests=new Set<AbortController>();
  let disposed=false,readController:AbortController|null=null,readTask:Promise<void>|null=null;
  let state:WorldVersionsState={view:null,loading:false,refreshing:false,applying:null,error:null};
  function update(patch:Partial<WorldVersionsState>){
    if(disposed)return;
    state={...state,...patch};
    for(const listener of listeners)listener();
  }
  function receive(value:WorldVersionsView){
    if(value?.worldId!==worldId||!Array.isArray(value.versions))throw new ApiError('INVALID_RESPONSE','Invalid release list');
    update({view:value});options.onSummary(value);
  }
  function read(refresh=false):Promise<void>{
    if(disposed||state.applying)return Promise.resolve();
    if(readTask&&(!refresh||state.refreshing))return readTask;
    readController?.abort();
    const controller=new AbortController();readController=controller;requests.add(controller);
    const current=()=>!disposed&&!controller.signal.aborted&&readController===controller;
    update({loading:!refresh,refreshing:refresh,error:null});
    const task=(async()=>{
      try{
        const {item}=await request<{item:WorldVersionsView}>(base+'/versions'+(refresh?'/refresh':''),{
          signal:controller.signal,...(refresh?{method:'POST'}:{}),
        });
        if(current())receive(item);
      }catch(reason){
        if(!current())return;
        // This GET only reads the preserved server file and the latest in-memory failure.
        if(refresh){
          try{
            const {item}=await request<{item:WorldVersionsView}>(base+'/versions',{signal:controller.signal});
            if(current())receive(item);
          }catch{/* Keep the previous successful list and the original failure. */}
        }
        if(current())update({error:reason});
      }finally{
        requests.delete(controller);
        if(current()){readTask=null;readController=null;update({loading:false,refreshing:false});}
      }
    })();
    readTask=task;return task;
  }
  async function apply(input:WorldVersionApplication):Promise<boolean>{
    if(disposed||state.applying||state.loading||state.refreshing)return false;
    const controller=new AbortController();requests.add(controller);
    update({applying:input.version,error:null});
    try{
      const {item}=await request<{item:WorldDetail}>(base+'/apply-version',{
        method:'POST',body:json(input),signal:controller.signal,
      });
      if(disposed||controller.signal.aborted)return false;
      if(item?.id!==worldId)throw new ApiError('INVALID_RESPONSE','Invalid updated world');
      if(state.view)update({view:{...state.view,currentVersion:item.currentVersion,latestVersion:item.latestVersion,updateStatus:item.updateStatus}});
      options.onApplied(item);
      return true;
    }catch(reason){
      if(!disposed&&!controller.signal.aborted)update({error:reason});
      return false;
    }finally{
      requests.delete(controller);
      if(!disposed)update({applying:null});
    }
  }
  return {
    getSnapshot:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    load:()=>read(),refresh:()=>read(true),apply,
    clearError:()=>update({error:null}),
    dispose(){disposed=true;for(const request of requests)request.abort();requests.clear();listeners.clear();},
  };
}
