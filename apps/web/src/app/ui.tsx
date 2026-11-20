import {Button} from '../components/ui/Button';
import {AlertCircle,LoaderCircle} from 'lucide-react';
export function ErrorNotice({message,onRetry}:{message:string;onRetry?:()=>void}){
  return <div className="notice" role="alert"><span className="inline-status"><AlertCircle size={17}/>{message}</span>{onRetry&&<Button size="compact" onClick={onRetry}>重试</Button>}</div>;
}
export function Loading({text='正在加载…'}:{text?:string}){
  return <div className="loading-panel" role="status"><LoaderCircle className="spinner-icon" size={18}/>{text}</div>;
}
