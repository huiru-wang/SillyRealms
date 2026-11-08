import type { SRSessionAPI, HistoryRunsResult, RunEvent } from './run-contract.js';

type Transport = {
  send(text:string):Promise<{runId:string;requestId:string}>;
  history(options?:{cursor?:string;limit?:number}):Promise<HistoryRunsResult>;
  setDraft(text:string):void;
};

/** The platform input owns the draft; this runtime forwards creator commands. */
export class SessionRuntime implements SRSessionAPI {
  private readonly listeners=new Set<(event:RunEvent)=>void>();
  constructor(private readonly transport:Transport) {}
  setDraft(text:string){this.transport.setDraft(text);}
  send(text:string){return this.transport.send(text);}
  getHistoryRuns(options?:{cursor?:string;limit?:number}){return this.transport.history(options);}
  subscribe(listener:(event:RunEvent)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  accept(event:RunEvent){for(const listener of this.listeners){try{listener(structuredClone(event));}catch{/* A creator listener cannot prevent other notifications. */}}}
}
