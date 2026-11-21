import {useEffect,useRef,useState} from 'react';
import {Activity,Check,CircleX} from 'lucide-react';
import {Button} from '../../components/ui/Button';
import {connectionTestError,testModelConnection} from './connection-test';
import type {ModelConfig} from './types';

/** Keyed by saved configuration version in ModelsPage, so results never follow an edited connection. */
export function ModelConnectionTest({model,disabled}:{model:ModelConfig;disabled:boolean}) {
  const running=useRef<AbortController|null>(null);
  const [testing,setTesting]=useState(false),[connected,setConnected]=useState(false),[error,setError]=useState('');
  useEffect(()=>()=>{running.current?.abort();running.current=null;},[]);
  const test=async()=>{
    if(disabled||running.current)return;
    const controller=new AbortController();running.current=controller;
    setTesting(true);setError('');setConnected(false);
    try{
      await testModelConnection(model.id,controller.signal);
      if(!controller.signal.aborted)setConnected(true);
    }catch(reason){if(!controller.signal.aborted)setError(connectionTestError(reason));}
    finally{
      if(running.current===controller)running.current=null;
      if(!controller.signal.aborted)setTesting(false);
    }
  };
  const label=testing?'正在测试':error?'连接失败':connected?'连接成功':'测试连接';
  return <Button size="compact" icon={error?<CircleX size={16}/>:connected?<Check size={16}/>:<Activity size={16}/>} intent={error?'danger':'neutral'} disabled={disabled} loading={testing} aria-live="polite" aria-atomic="true" title={error|| (connected?'连接成功，点击重新测试':'测试已保存的模型连接')} onClick={()=>void test()}>{label}</Button>;
}
