import type {ModelConnectionResult,ModelConnectionUsage} from './types.ts';

type Request=<T>(path:string,options?:RequestInit)=>Promise<T>;
const defaultRequest:Request=async<T>(path:string,options?:RequestInit)=>(await import('../../api')).api<T>(path,options);
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const usageFields=['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens'] as const;
function readUsage(value:unknown):ModelConnectionUsage|null {
  if(value===null)return null;
  if(!record(value)||usageFields.some(field=>!count(value[field])))throw Error('模型测试响应格式无效');
  return Object.fromEntries(usageFields.map(field=>[field,value[field]])) as ModelConnectionUsage;
}
/** Explicit user action only: the server loads this saved config and its credential. */
export async function testModelConnection(modelConfigId:string,signal?:AbortSignal,request:Request=defaultRequest):Promise<ModelConnectionResult> {
  signal?.throwIfAborted();
  const result=await request<unknown>('v1/api-model-configs/'+encodeURIComponent(modelConfigId)+'/test',{method:'POST',signal});
  signal?.throwIfAborted();
  if(!record(result)||result.connected!==true||typeof result.providerId!=='string'||!result.providerId||
    typeof result.modelId!=='string'||!result.modelId||!count(result.durationMs))throw Error('模型测试响应格式无效');
  return {connected:true,providerId:result.providerId,modelId:result.modelId,durationMs:result.durationMs,usage:readUsage(result.usage)};
}
export function connectionTestError(reason:unknown):string {
  const message=reason instanceof Error?reason.message:'模型连接测试失败';
  const code=reason&&typeof reason==='object'&&'errorCode' in reason&&typeof reason.errorCode==='string'?reason.errorCode:'';
  return code?message+'（'+code+'）':message;
}
