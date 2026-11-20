import {useCallback, useEffect, useRef, useState} from 'react';
import {api, ApiError} from './api';

export type Page<T> = {items:T[]; hasMore:boolean; nextCursor:string|null};
export function withCursor(path:string, cursor:string) {
  const [base, query=''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('cursor', cursor);
  return base+'?'+params;
}
export function checkPage<T>(value:Page<T>):Page<T> {
  if(!value || !Array.isArray(value.items) || typeof value.hasMore!=='boolean' ||
    !(value.nextCursor===null || typeof value.nextCursor==='string') || (value.hasMore&&!value.nextCursor)) {
    throw new ApiError('INVALID_RESPONSE','分页响应无效');
  }
  return value;
}
export function mergeItems<T extends {id:string}>(previous:T[], next:T[]) {
  return [...new Map([...previous,...next].map(item=>[item.id,item])).values()];
}

export function useResource<T>(path:string|null, revision=0) {
  const [value,setValue]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(!!path);
  const [attempt,setAttempt]=useState(0),[loadedPath,setLoadedPath]=useState(path);
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>{
    const abort=new AbortController();controller.current=abort;
    setLoadedPath(path);setValue(null);setError('');setLoading(!!path);
    if(path)void api<T>(path,{signal:abort.signal}).then(result=>{if(!abort.signal.aborted)setValue(result);})
      .catch(reason=>{if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'读取失败');})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>abort.abort();
  },[path,revision,attempt]);
  const reload=useCallback(()=>setAttempt(n=>n+1),[]);
  const replace=useCallback((result:T)=>{controller.current?.abort();setValue(result);setError('');setLoading(false);},[]);
  return {value:loadedPath===path?value:null,error:loadedPath===path?error:'',loading:loadedPath!==path||loading,reload,replace};
}

/** One page for workspaces, all summary pages for selectors; never fetch every detail. */
export function usePagedResource<T extends {id:string}>(path:string, revision=0, allPages=false) {
  const [page,setPage]=useState<Page<T>|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [attempt,setAttempt]=useState(0),[loadedPath,setLoadedPath]=useState(path);
  const controller=useRef<AbortController|null>(null),busy=useRef(false),pages=useRef(new Set<string>());
  useEffect(()=>{
    const abort=new AbortController();controller.current=abort;busy.current=true;pages.current=new Set();
    setLoadedPath(path);setPage(null);setError('');setLoading(true);
    void (async()=>{
      let result=checkPage(await api<Page<T>>(path,{signal:abort.signal}));
      while(allPages&&result.hasMore){
        abort.signal.throwIfAborted();
        const cursor=result.nextCursor!;
        if(pages.current.has(cursor))throw new ApiError('INVALID_RESPONSE','分页游标重复');
        pages.current.add(cursor);
        const next=checkPage(await api<Page<T>>(withCursor(path,cursor),{signal:abort.signal}));
        result={...next,items:mergeItems(result.items,next.items)};
      }
      if(!abort.signal.aborted)setPage(result);
    })().catch(reason=>{if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'读取失败');})
      .finally(()=>{if(!abort.signal.aborted){busy.current=false;setLoading(false);}});
    return()=>{abort.abort();};
  },[path,revision,allPages,attempt]);
  const more=async()=>{
    const abort=controller.current,cursor=page?.nextCursor;
    if(busy.current||!cursor||!abort||abort.signal.aborted)return;
    busy.current=true;setLoading(true);setError('');
    try{
      if(pages.current.has(cursor))throw new ApiError('INVALID_RESPONSE','分页游标重复');
      const result=checkPage(await api<Page<T>>(withCursor(path,cursor),{signal:abort.signal}));
      if(!abort.signal.aborted){pages.current.add(cursor);setPage(previous=>({...result,items:mergeItems(previous?.items??[],result.items)}));}
    }catch(reason){if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'读取失败');}
    finally{if(!abort.signal.aborted){busy.current=false;setLoading(false);}}
  };
  const reload=useCallback(()=>setAttempt(n=>n+1),[]);
  return {page:loadedPath===path?page:null,error:loadedPath===path?error:'',loading:loadedPath!==path||loading,more,reload};
}
