import type {HistoryRunsResult,Run,RunPhase,SessionRunEvent,StateEvent} from '@sillyrealms/sdk';
import {createRuns,createSnapshot,extensions,previewMatches,responseText,type PreviewKind,type PreviewScenario,type PreviewSnapshot} from './fixtures';

export type PreviewEvent = SessionRunEvent | StateEvent;
export type PreviewActivity = {active:boolean;phase:'preparing'|'narrative'|'extensions'|null};
type Store = {runs:Run[];state:PreviewSnapshot;sequence:number};
const stores = new Map<string,Store>();

/** Trusted local fixture transport. It never calls Server or implements its business rules. */
export class PreviewTransport {
  private readonly store:Store;
  private readonly timers=new Set<ReturnType<typeof setTimeout>>();
  private active:Run|null=null;
  private disposed=false;
  private historyFailures:number;
  private earlierFailures:number;
  private stateFailures:number;
  constructor(
    private readonly sessionId:string,
    private readonly kind:PreviewKind,
    private readonly scenario:PreviewScenario,
    private readonly emit:(event:PreviewEvent)=>void,
    private readonly activity:(activity:PreviewActivity)=>void,
  ){
    const key=sessionId+'\u0000'+kind+'\u0000'+scenario;
    const existing=stores.get(key);
    this.store=existing??{runs:createRuns(sessionId,kind,scenario),state:createSnapshot(kind),sequence:0};
    stores.set(key,this.store);
    this.historyFailures=scenario==='history-error'?1:0;
    this.earlierFailures=scenario==='earlier-error'?1:0;
    this.stateFailures=scenario==='state-error'?2:0;
  }

  async history(options?:{cursor?:string;limit?:number}):Promise<HistoryRunsResult>{
    this.ensureLive();
    if(options?.cursor){
      if(this.earlierFailures-->0)throw Error('本地样例：加载更早消息失败，请重试。');
    }else if(this.historyFailures-->0)throw Error('本地样例：历史加载失败，请重试。');
    const limit=options?.limit??5;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('无效的历史分页大小');
    let end=this.store.runs.length;
    if(options?.cursor!==undefined){
      const prefix=this.sessionId+':before:';
      if(!options.cursor.startsWith(prefix))throw Error('无效的预览游标');
      const value=options.cursor.slice(prefix.length);
      if(!/^\d+$/.test(value))throw Error('无效的预览游标');
      end=Number(value);
      if(!Number.isSafeInteger(end)||end<0||end>this.store.runs.length)throw Error('预览游标已失效');
    }
    const start=Math.max(0,end-limit);
    return {runs:structuredClone(this.store.runs.slice(start,end)),nextCursor:start?this.sessionId+':before:'+start:null,hasMore:start>0};
  }

  async readState():Promise<PreviewSnapshot>{
    this.ensureLive();
    if(this.stateFailures-->0)throw Error('本地样例：状态暂时不可用，请重试。');
    return structuredClone(this.store.state);
  }

  match(text:string,role:'user'|'assistant'){
    this.ensureLive();
    if(typeof text!=='string'||text.length>100000||!['user','assistant'].includes(role))throw Error('无效的预览消息');
    return previewMatches(text,role);
  }

  async send(text:string):Promise<{runId:string;requestId:string}>{
    this.ensureLive();
    if(typeof text!=='string'||!text.trim()||text.length>100000)throw Error('请输入有效内容（最多100000字符）');
    if(this.active)throw Error('本地预览正在生成，请稍候或停止。');
    if(this.scenario==='send-error')throw Error('本地样例：发送被拒绝，草稿已保留。');
    const sequence=++this.store.sequence;
    const runId=this.sessionId+':preview:'+sequence;
    const requestId=runId+':request';
    const run:Run={
      id:runId,status:'preparing',phase:'preparing',executionMode:'direct',
      messages:[{id:runId+':user',role:'user',text}],
    };
    this.store.runs.push(run);this.active=run;
    this.emit({event:'run.created',data:{runId,phase:'preparing',executionMode:'direct',messages:structuredClone(run.messages)}});
    this.activity({active:true,phase:'preparing'});
    this.schedule(280,()=>{
      this.phase(run,'narrative');
      const chars=Array.from(responseText(this.kind));
      const chunks:string[]=[];
      for(let index=0;index<chars.length;index+=9)chunks.push(chars.slice(index,index+9).join(''));
      const message={id:runId+':assistant',role:'assistant' as const,text:''};
      run.messages.push(message);
      chunks.forEach((text,index)=>this.schedule(55*(index+1),()=>{
        if(this.active!==run)return;
        const offset=message.text.length;
        message.text+=text;
        if(this.scenario==='snapshot'&&index===3){
          this.emit({event:'run.snapshot',data:{runId,status:'running',phase:'narrative',executionMode:'direct',messages:structuredClone(run.messages)}});
        }else if(!(this.scenario==='gap'&&index===2)&&!(this.scenario==='snapshot'&&index===2)){
          const event:SessionRunEvent={event:'run.delta',data:{runId,messageId:message.id,text,offset}};
          this.emit(event);
          if(this.scenario==='snapshot'&&index===1)this.emit(event);
        }
      }));
      this.schedule(55*(chunks.length+1),()=>{
        if(this.active!==run)return;
        this.phase(run,'extensions');
        this.schedule(350,()=>this.finish(run));
      });
    });
    return {runId,requestId};
  }

  stop():void{
    if(!this.active)return;
    const run=this.active;
    this.clearTimers();this.active=null;
    run.status='stopped';run.phase='finalized';run.extensions=extensions(this.kind,'cancelled','cancelled');
    this.emit({event:'run.stopped',data:{runId:run.id,executionMode:'direct',phase:'finalized',messages:structuredClone(run.messages),extensions:structuredClone(run.extensions)}});
    this.activity({active:false,phase:null});
  }

  dispose():void{
    this.stop();
    this.disposed=true;this.clearTimers();
  }

  private phase(run:Run,phase:Exclude<RunPhase,'finalized'>){
    if(this.active!==run||this.disposed)return;
    run.phase=phase;run.status=phase==='preparing'?'preparing':'running';
    this.activity({active:true,phase});
    this.emit({event:'run.phase',data:{runId:run.id,phase}});
  }

  private finish(run:Run){
    if(this.active!==run||this.disposed)return;
    this.active=null;
    run.phase='finalized';
    if(this.scenario==='run-failed'){
      // The terminal payload is authoritative: uncommitted provisional text is removed.
      run.status='failed';run.messages=[];
      this.emit({event:'run.failed',data:{runId:run.id,phase:'finalized',executionMode:'direct',messages:[],errorCode:'PREVIEW_COMMIT_FAILED',errorMessage:'本地样例：模拟终态保存失败。'}});
    }else{
      run.status='completed';
      const state=this.scenario==='state-partial'?'partial':'applied';
      const suggestion=this.scenario==='state-partial'?'blocked':this.scenario==='suggestion-failed'?'failed':'ready';
      run.extensions=extensions(this.kind,state,suggestion);
      const clues=Number(this.store.state.message.线索??0)+1;
      this.store.state.message.线索=clues;
      this.emit({event:'state.changed',data:{scope:'message',path:'线索',value:clues}});
      this.emit({event:'run.completed',data:{runId:run.id,phase:'finalized',executionMode:'direct',messages:structuredClone(run.messages),extensions:structuredClone(run.extensions)}});
    }
    this.activity({active:false,phase:null});
  }

  private ensureLive(){if(this.disposed)throw Error('预览已关闭');}
  private schedule(delay:number,callback:()=>void){
    const timer=setTimeout(()=>{this.timers.delete(timer);if(!this.disposed)callback();},delay);
    this.timers.add(timer);
  }
  private clearTimers(){for(const timer of this.timers)clearTimeout(timer);this.timers.clear();}
}
