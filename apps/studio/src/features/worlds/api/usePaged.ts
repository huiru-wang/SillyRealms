import {useCallback,useEffect,useRef,useState} from 'react';
import type {Page} from './worlds';
export function usePaged<T>(key:string,load:(cursor:string|null,signal:AbortSignal)=>Promise<Page<T>>){
  const [page,setPage]=useState<Page<T>|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const [revision,setRevision]=useState(0);
  const [pageKey,setPageKey]=useState(key);
  const latest=useRef(load);latest.current=load;
  const controller=useRef<AbortController|null>(null);
  const busy=useRef(false);
  useEffect(()=>{
    const c=new AbortController();controller.current=c;busy.current=true;setPageKey(key);setPage(null);setLoading(true);setError(false);
    latest.current(null,c.signal).then(result=>{if(!c.signal.aborted)setPage(result);}).catch(()=>{if(!c.signal.aborted)setError(true);}).finally(()=>{if(!c.signal.aborted){busy.current=false;setLoading(false);}});
    return()=>{c.abort();busy.current=false;};
  },[key,revision]);
  const more=useCallback(()=>{
    if(busy.current||!page?.nextCursor)return;
    const c=controller.current;if(!c||c.signal.aborted)return;
    busy.current=true;setLoading(true);setError(false);
    latest.current(page.nextCursor,c.signal).then(result=>{if(!c.signal.aborted)setPage(previous=>previous?{...result,items:[...previous.items,...result.items]}:result);}).catch(()=>{if(!c.signal.aborted)setError(true);}).finally(()=>{if(!c.signal.aborted){busy.current=false;setLoading(false);}});
  },[page]);
  return {page:pageKey===key?page:null,loading:pageKey!==key||loading,error:pageKey===key&&error,more,retry:()=>page?more():setRevision(n=>n+1)};
}
