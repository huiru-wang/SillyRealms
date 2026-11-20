import type {StateChangedEvent,StateScope,StateSnapshot,StateValue,StateWrite,StateWriteResult} from '../../../../../packages/sr-sdk/src/stage-contract.js';
import {applyStateChange,isStateObject,isStatePath,isStateScope,isStateValue,messageValues,objectValues,stateScopes,type StateObject} from './values.ts';
export {stateManifest} from './manifest.ts';
export type {StateManifest} from './manifest.ts';
export type {StateChangedEvent,StateScope,StateSnapshot,StateValue,StateWrite,StateWriteResult};

export type StateControllerSnapshot={values:StateSnapshot;loading:boolean;error:string|null};
export type StateRequest=<T>(path:string,options?:RequestInit)=>Promise<T>;
export type StateControllerOptions={
  sessionId:string;worldId:string;getTipEntryId:()=>string|null;request?:StateRequest;
};
type PreparedWrite={scope:StateScope;path:string;value:StateValue}|{failure:StateWriteResult};
const defaultRequest:StateRequest=async<T>(path:string,options?:RequestInit)=>(await import('../../api')).api<T>(path,options);
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'状态请求失败';
function failure(scope:StateScope,path:string,error:unknown,code='STATE_REQUEST_FAILED'):StateWriteResult {
  const supplied=error!==null&&typeof error==='object'&&'errorCode' in error&&typeof error.errorCode==='string'
    ?error.errorCode:code;
  return {scope,path,success:false,errorCode:supplied,errorMessage:errorMessage(error)};
}
function prepareWrite(input:StateWrite):PreparedWrite {
  const scope=isStateScope(input?.scope)?input.scope:'message',path=typeof input?.path==='string'?input.path:'';
  if(!input||!isStateObject(input)||(input.scope!==undefined&&!isStateScope(input.scope)))
    return {failure:failure(scope,path,Error('状态作用域无效'),'INVALID_STATE_SCOPE')};
  if(!isStatePath(path))return {failure:failure(scope,path,Error('状态字段路径无效'),'INVALID_STATE_PATH')};
  if(!Object.hasOwn(input,'value')||!isStateValue(input.value))
    return {failure:failure(scope,path,Error('状态值必须是有效 JSON'),'INVALID_STATE_VALUE')};
  return {scope,path,value:structuredClone(input.value)};
}
function writeResults(value:unknown,updates:Array<Exclude<PreparedWrite,{failure:StateWriteResult}>>):StateWriteResult[] {
  return updates.map((update,index)=>{
    const item=Array.isArray(value)?value[index]:undefined;
    if(!isStateObject(item)||item.path!==update.path||item.scope!==update.scope||
      (item.success===true?(item.errorCode!==null||item.errorMessage!==''):
        item.success!==false||typeof item.errorCode!=='string'||!item.errorCode||typeof item.errorMessage!=='string'))
      return failure(update.scope,update.path,Error('状态写入响应格式无效'),'INVALID_RESPONSE');
    return {
      path:update.path,scope:update.scope,
      ...(item.success?{success:true as const,errorCode:null,errorMessage:'' as const}:
        {success:false as const,errorCode:item.errorCode as string,errorMessage:item.errorMessage as string}),
      ...(isStateScope(item.stateScope)?{stateScope:item.stateScope}:{}),
      ...(typeof item.statePath==='string'?{statePath:item.statePath}:{}),
      ...(typeof item.rulePath==='string'?{rulePath:item.rulePath}:{}),
    };
  });
}

/** Owns state transport and snapshots. Narrative state and lifecycle remain outside this feature. */
export function createStateController({sessionId,worldId,getTipEntryId,request=defaultRequest}:StateControllerOptions) {
  const lifetime=new AbortController(),listeners=new Set<()=>void>();
  const generations:Record<StateScope,number>={global:0,session:0,message:0};
  const events:Record<StateScope,number>={global:0,session:0,message:0};
  const pending:Partial<Record<StateScope,Promise<StateObject>>>={};
  const readErrors:Partial<Record<StateScope,string>>={};
  let disposed=false,reading=0,writeError:string|null=null,queue:Promise<void>=Promise.resolve();
  let snapshot:StateControllerSnapshot={values:{global:{},session:{},message:{}},loading:false,error:null};
  const open=()=>{if(disposed)throw new DOMException('状态连接已关闭','AbortError');};
  function publish(values=snapshot.values) {
    if(disposed)return;
    const errors=[writeError,...stateScopes.map(scope=>readErrors[scope])].filter((value):value is string=>!!value);
    snapshot={values,loading:reading>0,error:[...new Set(errors)].join('；')||null};
    for(const listener of [...listeners]){try{listener();}catch{/* An observer cannot block other observers or requests. */}}
  }
  function endpoint(scope:StateScope,tip=getTipEntryId()) {
    if(scope==='global')return 'v1/state/global/'+encodeURIComponent(worldId);
    if(scope==='session')return 'v1/state/session/'+encodeURIComponent(sessionId);
    if(!tip)throw Error('当前会话尚无消息状态');
    return 'v1/state/message/'+encodeURIComponent(sessionId)+'/'+encodeURIComponent(tip);
  }
  function refreshScope(scope:StateScope):Promise<StateObject> {
    open();generations[scope]++;
    if(pending[scope])return pending[scope]!;
    reading++;
    // Defer execution until pending is registered, including synchronous observer re-entry.
    const task=Promise.resolve().then(async()=>{
      while(true){
        open();
        const generation=generations[scope],observed=events[scope],tip=getTipEntryId();
        try{
          const response=scope==='message'&&tip===null?{item:null}:
            await request<{item:unknown}>(endpoint(scope,tip),{signal:lifetime.signal});
          open();
          // An older response must neither undo an event nor leave unobserved roots uninitialized.
          if(generation!==generations[scope]||observed!==events[scope]||
            (scope==='message'&&tip!==getTipEntryId()))continue;
          if(!isStateObject(response)||!Object.hasOwn(response,'item'))throw Error('状态响应格式无效');
          const value=scope==='message'?messageValues(response.item):objectValues(response.item);
          delete readErrors[scope];publish({...snapshot.values,[scope]:value});
          if(generation!==generations[scope]||observed!==events[scope])continue;
          return value;
        }catch(error){
          open();
          if(generation!==generations[scope]||observed!==events[scope]||
            (scope==='message'&&tip!==getTipEntryId()))continue;
          readErrors[scope]=errorMessage(error);publish();throw error;
        }
      }
    }).finally(()=>{
      if(pending[scope]===task)delete pending[scope];
      reading--;publish();
    });
    pending[scope]=task;publish();return task;
  }
  function serialize<T>(work:()=>Promise<T>):Promise<T> {
    const result=queue.then(()=>{open();return work();});
    queue=result.then(()=>undefined,()=>undefined);return result;
  }
  async function reconcile(scope:StateScope) {
    if(disposed)return;
    try{await refreshScope(scope);}catch{/* The write receipt stays authoritative even when its follow-up read fails. */}
  }
  return {
    getSnapshot:()=>snapshot,
    subscribe(listener:()=>void) {
      if(disposed)return ()=>{};
      listeners.add(listener);return ()=>{listeners.delete(listener);};
    },
    async read():Promise<StateSnapshot> {
      open();
      const results=await Promise.allSettled(stateScopes.map(refreshScope));
      open();
      const rejected=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');
      if(rejected)throw rejected.reason;
      return structuredClone(snapshot.values);
    },
    write(updates:StateWrite[]):Promise<StateWriteResult[]> {
      if(!Array.isArray(updates))return Promise.reject(Error('状态更新必须是数组'));
      const prepared=Array.from(updates,prepareWrite);
      return serialize(async()=>{
        writeError=null;publish();
        const results:StateWriteResult[]=[];
        for(let index=0;index<prepared.length;){
          open();
          const first=prepared[index]!;
          if('failure' in first){results.push(first.failure);index++;continue;}
          const group=[first];index++;
          while(index<prepared.length){
            const next=prepared[index]!;
            if('failure' in next||next.scope!==first.scope)break;
            group.push(next);index++;
          }
          try{
            const response=await request<unknown>(endpoint(first.scope),{
              method:'PATCH',body:JSON.stringify({updates:group.map(({path,value})=>({path,value}))}),signal:lifetime.signal,
            });
            open();results.push(...writeResults(response,group));
          }catch(error){
            open();results.push(...group.map(update=>failure(update.scope,update.path,error)));
          }
          // Success may mean an ignored missing path. Only reads/events update local values.
          await reconcile(first.scope);
        }
        open();writeError=[...new Set(results.filter(result=>!result.success).map(result=>result.errorMessage))].join('；')||null;
        publish();return results;
      });
    },
    replace(scope:StateScope,value:StateValue):Promise<void> {
      let state:StateValue;
      try{
        if(!isStateScope(scope))throw Error('状态作用域无效');
        scope==='message'?messageValues(value):objectValues(value);
        state=structuredClone(value);
      }catch(error){return Promise.reject(error);}
      return serialize(async()=>{
        writeError=null;publish();
        try{
          await request(endpoint(scope),{method:'PUT',body:JSON.stringify({state}),signal:lifetime.signal});
          open();
        }catch(error){open();writeError=errorMessage(error);publish();throw error;}
        finally{await reconcile(scope);}
      });
    },
    accept(event:StateChangedEvent) {
      if(disposed||event?.event!=='state.changed'||!isStateObject(event.data)||
        !isStateScope(event.data.scope)||typeof event.data.path!=='string'||!isStateValue(event.data.value))return;
      const {scope,path,value}=event.data;
      if(path!==''&&!isStatePath(path))return;
      if(path===''&&!isStateObject(value))return;
      events[scope]++;
      const next=applyStateChange(snapshot.values[scope],path,value);
      if(next)publish({...snapshot.values,[scope]:next});
      else void refreshScope(scope).catch(()=>{});
    },
    dispose() {
      if(disposed)return;
      disposed=true;lifetime.abort();listeners.clear();snapshot={...snapshot,loading:false};
    },
  };
}
export type StateController=ReturnType<typeof createStateController>;
