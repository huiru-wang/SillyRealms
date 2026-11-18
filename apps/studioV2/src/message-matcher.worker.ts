import {matchMessage} from '../../../packages/sr-sdk/src/message-matching';
import type {MessageMatch,MessageRule} from '../../../packages/sr-sdk/src/story-types';

self.postMessage({type:'ready'});
self.onmessage=(event:MessageEvent<{text:string;role:'user'|'assistant';rules:MessageRule[];initial:MessageMatch[]}>)=>{
  try {
    const {text,role,rules,initial}=event.data;
    const matches=matchMessage(text,role,rules,(step,invalid,index,accepted)=>self.postMessage({type:step==='start'?'rule-start':'rule-end',invalid,index,...(step==='end'?{matches:accepted}:{})}),initial);
    self.postMessage({type:'result',matches});
  } catch {self.postMessage({type:'error'});}
};
