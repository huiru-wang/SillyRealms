import type {Run} from './run-contract.js';

/** Explicit runtime DEBUG opt-in; ordinary play never shows plugin diagnostics. */
export function postprocessFeedback(run:Run,debug=false):string[] {
  if(!debug)return [];
  const messages:string[]=[];
  const state=run.extensions?.stateUpdate.status;
  if(state==='partial')messages.push('部分或全部状态更新未通过校验。');
  if(state==='failed')messages.push('本轮状态更新失败，未提交状态更新。');
  if(run.extensions?.actionSuggestions.status==='failed')messages.push('本轮行动建议不可用，可以继续输入。');
  return messages;
}

export function isPostprocessError(code:unknown):boolean {
  return typeof code==='string'&&[
    'EXTENSION_PROTOCOL_INVALID','EXTENSION_TAIL_TOO_LARGE',
    'STATE_UPDATE_MISSING','STATE_UPDATE_INVALID','INVALID_STATE_UPDATE','ACTION_SUGGESTIONS_INVALID',
    'STATE_RULE_MISSING','INVALID_STATE_RULE_PATH',
  ].includes(code);
}
