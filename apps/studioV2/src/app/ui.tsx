import {PageHeader} from '../components/ui/PageHeader';
import {Button} from '../components/ui/Button';
import React, {useCallback,useEffect,useRef,useState} from 'react';
import {AlertCircle,ArrowRight,LoaderCircle,Search,Layers3} from 'lucide-react';
import {Link} from 'react-router-dom';
import {api} from '../api';

export function usePaged(path:string){
  const [value,setValue]=useState<any>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const generation=useRef(0);
  const reload=useCallback(async()=>{
    const id=++generation.current;setLoading(true);
    try{const result=await api(path);if(id===generation.current){setValue(result);setError('');}}
    catch(e){if(id===generation.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(id===generation.current)setLoading(false);}
  },[path]);
  const more=async()=>{
    if(loading||!value?.nextCursor)return;
    const id=generation.current;setLoading(true);
    try{const result=await api(path+'&cursor='+encodeURIComponent(value.nextCursor));if(id===generation.current)setValue((prev:any)=>({...result,items:[...(prev?.items??[]),...result.items]}));}
    catch(e){if(id===generation.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(id===generation.current)setLoading(false);}
  };
  useEffect(()=>{setValue(null);setError('');void reload();return()=>{generation.current++;};},[path,reload]);
  return {value,error,loading,reload,more};
}
export async function request(fn:()=>Promise<any>,after:()=>void){try{await fn();after();}catch(e){alert(e instanceof Error?e.message:String(e));}}
/** Primary page hierarchy: heading -> supporting sentence -> one primary action. */
export function Header({eyebrow,title,description,children}:{eyebrow:string;title:string;description:string;children?:React.ReactNode}){
  return <PageHeader title={title} description={description} actions={children}/>;
}
export function Empty({text,action,to}:{text:string;action?:string;to?:string}){
  return <div className="empty"><div className="empty-icon"><Layers3 size={22}/></div><strong>{text}</strong>{action&&to&&<Link className="sr-button" data-variant="secondary" to={to}>{action}<ArrowRight size={15}/></Link>}</div>;
}
export function ErrorNotice({message,onRetry}:{message:string;onRetry?:()=>void}){
  return <div className="notice" role="alert"><span className="inline-status"><AlertCircle size={17}/>{message}</span>{onRetry&&<Button size="compact" onClick={onRetry}>重试</Button>}</div>;
}
export function Loading({text='正在加载…'}:{text?:string}){
  return <div className="loading-panel" role="status"><LoaderCircle className="spinner-icon" size={18}/>{text}</div>;
}
export function SearchInput({value,onChange,placeholder}:{value:string;onChange:(value:string)=>void;placeholder:string}){
  return <label className="search-field"><Search size={17}/><input className="sr-input" value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}/></label>;
}
