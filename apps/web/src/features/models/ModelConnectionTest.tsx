import {useTranslation} from 'react-i18next';
import {useEffect,useRef,useState} from 'react';
import {Activity,Check,CircleX} from 'lucide-react';
import {Button} from '../../components/ui/Button';
import {connectionTestError,testModelConnection} from './connection-test';
import type {ModelConfig} from './types';

/** Keyed by saved configuration version in ModelsPage, so results never follow an edited connection. */
export function ModelConnectionTest({model,disabled}:{model:ModelConfig;disabled:boolean}) {
  const {t} = useTranslation('models');
  const running=useRef<AbortController|null>(null);
  const [testing,setTesting]=useState(false),[connected,setConnected]=useState(false),[error,setError]=useState<{reason:unknown}|null>(null);
  useEffect(()=>()=>{running.current?.abort();running.current=null;},[]);
  const test=async()=>{
    if(disabled||running.current)return;
    const controller=new AbortController();running.current=controller;
    setTesting(true);setError(null);setConnected(false);
    try{
      await testModelConnection(model.id,controller.signal);
      if(!controller.signal.aborted)setConnected(true);
    }catch(reason){if(!controller.signal.aborted)setError({reason});}
    finally{
      if(running.current===controller)running.current=null;
      if(!controller.signal.aborted)setTesting(false);
    }
  };
  const label=testing?t('testing'):error?t('connectionFailed'):connected?t('connected'):t('testConnection');
  return <Button size="compact" icon={error?<CircleX size={16}/>:connected?<Check size={16}/>:<Activity size={16}/>} intent={error?'danger':'neutral'} disabled={disabled} loading={testing} aria-live="polite" aria-atomic="true" title={error?connectionTestError(error.reason):(connected?t('connectedClickToTestAgain'):t('testTheSavedModelConnection'))} onClick={()=>void test()}>{label}</Button>;
}
