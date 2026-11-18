import type {MessageMatch,MessageRule} from '../../../packages/sr-sdk/src/story-types';

type Job={text:string;role:'user'|'assistant';rules:MessageRule[];resolve:(value:unknown)=>void;reject:(error:Error)=>void};
export class MessageMatcher {
  private active=new Set<()=>void>();
  private queue:Job[]=[];
  private closed=false;
  match(text:string,role:'user'|'assistant',rules:MessageRule[]):Promise<unknown> {
    if(this.closed||new TextEncoder().encode(text).byteLength>1024*1024||rules.length>100||this.queue.length>=100)return Promise.reject(Error('消息处理超出限制'));
    return new Promise((resolve,reject)=>{this.queue.push({text,role,rules,resolve,reject});this.drain();});
  }
  private drain(){
    while(!this.closed&&this.active.size<4&&this.queue.length)this.run(this.queue.shift()!);
  }
  private run(job:Job){
    let worker:Worker|undefined,perRule:ReturnType<typeof setTimeout>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    let remaining=job.rules,accepted:MessageMatch[]=[],warning=false,currentIndex=0,elapsed=0,start=0,done=false;
    const cancel=()=>finish(Error('会话已关闭'));
    const finish=(error?:Error)=>{
      if(done)return;done=true;clearTimeout(timer);clearTimeout(perRule);worker?.terminate();this.active.delete(cancel);
      error?job.reject(error):job.resolve({matches:accepted.sort((a,b)=>a.start-b.start),warning});this.drain();
    };
    const launch=()=>{
      if(this.closed){finish(Error('会话已关闭'));return;}
      if(!remaining.length||elapsed>=250){if(remaining.length)warning=true;finish();return;}
      try {worker=new Worker(new URL('./message-matcher.worker.ts',import.meta.url),{type:'module'});}
      catch {finish(Error('消息处理不可用'));return;}
      const currentWorker=worker;
      timer=setTimeout(()=>finish(Error('消息处理启动超时')),3000);
      worker.onmessage=event=>{
        if(done||worker!==currentWorker)return;
        if(event.data?.type==='ready'){
          clearTimeout(timer);start=performance.now();timer=setTimeout(()=>{warning=true;finish();},Math.max(1,250-elapsed));
          worker?.postMessage({text:job.text,role:job.role,rules:remaining,initial:accepted});
        } else if(event.data?.type==='rule-start'){
          currentIndex=event.data.index;clearTimeout(perRule);
          perRule=setTimeout(()=>{
            elapsed+=performance.now()-start;warning=true;clearTimeout(timer);worker?.terminate();
            remaining=remaining.slice(currentIndex+1);launch();
          },50);
        } else if(event.data?.type==='rule-end'){
          clearTimeout(perRule);warning ||= event.data.invalid===true;accepted=event.data.matches;
        } else if(event.data?.type==='result'){
          accepted=event.data.matches;finish();
        } else if(event.data?.type==='error')finish(Error('消息处理超出限制'));
      };
      worker.onerror=()=>{if(worker===currentWorker)finish(Error('消息处理失败'));};
    };
    this.active.add(cancel);launch();
  }
  close(){this.closed=true;for(const cancel of this.active)cancel();this.active.clear();for(const job of this.queue)job.reject(Error('会话已关闭'));this.queue=[];}
}
