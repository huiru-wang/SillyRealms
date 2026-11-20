import {useEffect,useRef,useState} from 'react';
import {Activity,Check} from 'lucide-react';
import {Button} from '../../components/ui/Button';
import {ErrorNotice} from '../../app/ui';
import {connectionTestError,testModelConnection} from './connection-test';
import type {ModelConfig,ModelConnectionResult} from './types';
import styles from './ModelsPage.module.css';

const number=(value:number)=>new Intl.NumberFormat('en').format(value);
/** Keyed by saved configuration version in ModelsPage, so results never follow an edited connection. */
export function ModelConnectionTest({model,disabled,editing}:{model:ModelConfig;disabled:boolean;editing:boolean}) {
  const running=useRef<AbortController|null>(null);
  const [testing,setTesting]=useState(false),[result,setResult]=useState<ModelConnectionResult|null>(null),[error,setError]=useState('');
  useEffect(()=>()=>{running.current?.abort();running.current=null;},[]);
  const test=async()=>{
    if(disabled||running.current)return;
    const controller=new AbortController();running.current=controller;
    setTesting(true);setError('');setResult(null);
    try{
      const value=await testModelConnection(model.id,controller.signal);
      if(!controller.signal.aborted)setResult(value);
    }catch(reason){if(!controller.signal.aborted)setError(connectionTestError(reason));}
    finally{
      if(running.current===controller)running.current=null;
      if(!controller.signal.aborted)setTesting(false);
    }
  };
  return <section className={styles.connectionTest} aria-label="模型连接测试">
    <div className={styles.connectionTestHeading}>
      <div><h3>模型连接测试</h3><p>{editing?'请先保存或关闭编辑草稿，再测试已保存的模型配置。':'点击后使用已保存的模型与凭据发起一次实际调用。'}</p></div>
      <Button icon={<Activity size={16}/>} disabled={disabled} loading={testing} onClick={()=>void test()}>{testing?'正在测试':'测试连接'}</Button>
    </div>
    {error&&<ErrorNotice message={error}/>}
    {result&&<>
      <p className={styles.credential} role="status"><Check size={16}/>连接成功</p>
      <dl className={styles.modelSpecs} aria-label="模型连接测试结果">
        <div><dt>服务商</dt><dd>{result.providerId}</dd></div>
        <div><dt>模型</dt><dd>{result.modelId}</dd></div>
        <div><dt>耗时</dt><dd>{number(result.durationMs)} ms</dd></div>
        <div><dt>总用量</dt><dd>{result.usage===null?'模型未返回完整用量':number(result.usage.totalTokens)+' Tokens'}</dd></div>
        {result.usage&&<>
          <div><dt>输入</dt><dd>{number(result.usage.inputTokens)} Tokens</dd></div>
          <div><dt>输出</dt><dd>{number(result.usage.outputTokens)} Tokens</dd></div>
          <div><dt>缓存读取</dt><dd>{number(result.usage.cacheReadTokens)} Tokens</dd></div>
          <div><dt>缓存写入</dt><dd>{number(result.usage.cacheWriteTokens)} Tokens</dd></div>
        </>}
      </dl>
    </>}
  </section>;
}
