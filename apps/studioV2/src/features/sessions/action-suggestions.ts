import type { ActionSuggestions, ActionSuggestionsEvent } from '../../../../../packages/sr-sdk/src/run-contract.js';
/** Host-owned transient batch. Accepted runs invalidate prior suggestions, including failed preparations. */
export class ActionSuggestionStore {
  private revision=0;
  get version(){return this.revision;}
  private latest: string|null=null;
  private seen=new Set<string>();
  private delivered=new Set<string>();
  private completed=new Map<string,Set<string>>();
  private batch:ActionSuggestions|null=null;
  constructor(private sessionId:string,private emit:(event:ActionSuggestionsEvent)=>void){}
  reset(){this.revision++;this.latest=null;this.seen.clear();this.delivered.clear();this.completed.clear();this.batch=null;this.publish();}
  accepted(runId:string){
    if(this.seen.has(runId))return;
    this.revision++;this.seen.add(runId);this.latest=runId;this.batch=null;this.publish();
  }
  settled(runId:string,status:string,messages:Array<{id:string;role:string}>){
    if(status==='completed')this.completed.set(runId,new Set(messages.filter(m=>m.role==='assistant').map(m=>m.id)));
  }
  receive(data:ActionSuggestionsEvent['data']){
    const b=data.suggestions;
    if(data.sessionId!==this.sessionId||!b||b.runId!==this.latest||!this.completed.get(b.runId)?.has(b.messageId)||b.items.length!==3||b.items.some(v=>typeof v!=='string'||!v.trim()||[...v].length>50)||new Set(b.items).size!==3)return;
    const key=b.runId+'\0'+b.messageId;if(this.delivered.has(key))return;
    this.delivered.add(key);this.batch=structuredClone(b);this.publish();
  }
  verifyLatest(runId:string|undefined,version=this.revision){if(version===this.revision&&this.batch&&this.batch.runId!==runId){this.batch=null;this.publish();}}
  publish(){this.emit({event:'action_suggestions.changed',data:{sessionId:this.sessionId,suggestions:this.batch?structuredClone(this.batch):null}});}
}
