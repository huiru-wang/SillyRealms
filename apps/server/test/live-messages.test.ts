import {expect,it} from 'vitest';
import {LiveMessages} from '../../web/src/live-messages.js';
it('merges streaming segments in one run without duplicates or separators',()=>{
 const live=new LiveMessages();live.load([{runId:'open',status:'completed',user:null,assistantSegments:[{id:'o',text:'开局',createdAt:1}]}]);
 live.event('message.created',{runId:'run',message:{id:'u',role:'user',text:'你好',createdAt:2,status:'completed'}});
 live.event('message.created',{runId:'run',message:{id:'a',role:'assistant',text:'',createdAt:3}});
 expect(live.event('message.delta',{runId:'run',messageId:'a',offset:0,text:'你'})).toBe(false);
 live.event('message.delta',{runId:'run',messageId:'a',offset:0,text:'你好'});
 live.event('message.delta',{runId:'run',messageId:'b',offset:0,text:'世界'});
 live.event('run.updated',{runId:'run',status:'completed'});
 expect(live.list().map(m=>m.text)).toEqual(['开局','你好','你好世界']);
 expect(live.list().at(-1)?.status).toBe('completed');
});
it('detects missing and conflicting stream offsets for resynchronization',()=>{
 const live=new LiveMessages();live.load([{runId:'r',status:'running',user:null,assistantSegments:[{id:'a',text:'abcd',createdAt:1}]}]);
 expect(live.event('message.delta',{runId:'r',messageId:'a',offset:7,text:'x'})).toBe(true);
 expect(live.event('message.delta',{runId:'r',messageId:'a',offset:1,text:'X'})).toBe(true);
 expect(live.list()[0]?.text).toBe('abcd');
});
