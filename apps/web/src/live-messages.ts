type ChatMessage={id:string;runId:string;role:'user'|'assistant';text:string;status:string;createdAt:number};
type Segment={id:string;text:string;createdAt:number};
type Run={runId:string;status:string;user:ChatMessage|null;assistantSegments:Segment[]};
export class LiveMessages {
  private runs:Run[]=[];
  load(runs:any[],prepend=false,preserve=false){const mapped:Run[]=runs.map(r=>({runId:r.runId,status:r.status,user:r.user?{...r.user,runId:r.runId}:null,assistantSegments:r.assistantSegments.map((s:any)=>({...s}))}));if(prepend){const ids=new Set(this.runs.map(r=>r.runId));this.runs=[...mapped.filter(r=>!ids.has(r.runId)),...this.runs];}else if(preserve){const ids=new Set(mapped.map(r=>r.runId));this.runs=[...this.runs.filter(r=>!ids.has(r.runId)),...mapped];}else this.runs=mapped;}
  list():ChatMessage[]{return this.runs.flatMap(r=>[...(r.user?[r.user]:[]),...(r.assistantSegments.some(s=>s.text)?[{id:'assistant:'+r.runId,runId:r.runId,role:'assistant' as const,text:r.assistantSegments.map(s=>s.text).join(''),status:r.status,createdAt:r.assistantSegments[0]!.createdAt}]:[])]);}
  event(type:string,p:any):boolean {
    let run=this.runs.find(r=>r.runId===p.runId);
    if(!run && (type==='message.created'||type==='message.delta')){run={runId:p.runId,status:'running',user:null,assistantSegments:[]};this.runs.push(run);}
    if(!run)return false;
    if(type==='message.created'){
      if(p.message.role==='user'){if(!run.user)run.user={...p.message,runId:p.runId};}
      else if(!run.assistantSegments.some(s=>s.id===p.message.id))run.assistantSegments.push({id:p.message.id,text:p.message.text??'',createdAt:p.message.createdAt});
    }else if(type==='message.delta'){
      let segment=run.assistantSegments.find(s=>s.id===p.messageId);
      if(!segment){if(p.offset!==0)return true;segment={id:p.messageId,text:'',createdAt:Date.now()};run.assistantSegments.push(segment);}
      if(p.offset>segment.text.length)return true;
      const overlap=Math.min(segment.text.length-p.offset,p.text.length);
      if(segment.text.slice(p.offset,p.offset+overlap)!==p.text.slice(0,overlap))return true;
      segment.text+=p.text.slice(overlap);
    }else if(type==='run.updated')run.status=p.status;
    return false;
  }
}
