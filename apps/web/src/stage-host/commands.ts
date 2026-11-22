import type {StageCommand, StageCommandMap} from '../../../../packages/sr-sdk/src/stage-contract.ts';
const object=(value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const only=(value: Record<string,unknown>, keys: string[]) => Object.keys(value).every(key=>keys.includes(key));
/** Validate the bridge vocabulary. Resource identity always comes from the bound session. */
export async function dispatchStageCommand(command: StageCommand, method: unknown, input: unknown): Promise<unknown> {
  if(typeof method !== 'string' || !object(input)) throw Error('舞台请求无效');
  switch(method){
    case 'narrative.send': case 'composer.setDraft':
      if(!only(input,['text']) || typeof input.text !== 'string' || input.text.length > 100000 || (method==='narrative.send'&&!input.text.trim())) throw Error('请输入有效内容');
      break;
    case 'narrative.regenerate':
      if(!only(input,['userEntryId','assistantEntryId']) || typeof input.userEntryId !== 'string' || !input.userEntryId.trim() || !(input.assistantEntryId === null || typeof input.assistantEntryId === 'string' && !!input.assistantEntryId.trim())) throw Error('重新生成目标无效');
      break;
    case 'narrative.stop':
      if(!only(input,['runId','assistantEntryId']) || typeof input.assistantEntryId !== 'string' || !input.assistantEntryId.trim() || typeof input.runId !== 'string' || !input.runId.trim()) throw Error('运行标识无效');
      break;
    case 'history.loadMore': case 'history.refresh': case 'state.read':
      if(Object.keys(input).length) throw Error('请求参数无效');
      break;
    case 'history.query':
      if(!only(input,['cursor','afterSeq','limit']) || (input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor)) ||
        (input.afterSeq!==undefined&&(!Number.isSafeInteger(input.afterSeq)||Number(input.afterSeq)<0)) ||
        (input.limit!==undefined&&(!Number.isInteger(input.limit)||Number(input.limit)<1||Number(input.limit)>5)) || (input.cursor!==undefined&&input.afterSeq!==undefined)) throw Error('历史查询参数无效');
      break;
    case 'state.write':
      if(!only(input,['updates']) || !Array.isArray(input.updates) || input.updates.some(update=>
        !object(update)||!only(update,['scope','path','value'])||typeof update.path!=='string'||!update.path||!Object.hasOwn(update,'value')||
        (update.scope!==undefined&&!['global','session','message'].includes(String(update.scope))))) throw Error('状态更新参数无效');
      break;
    default: throw Error('舞台不支持此命令');
  }
  return command(method as keyof StageCommandMap,input as never);
}
