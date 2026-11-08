import type { SRStateAPI, StateEvent, StateScope, StateValue } from './state-contract.js';

type Snapshot = Record<StateScope, Record<string, StateValue>>;
type Entry = { path:string; scope?:StateScope; value:StateValue };
type Result = { path:string; scope:StateScope; success:boolean; message:string };
type Transport = { read():Promise<Snapshot>; write(entries:Entry[]):Promise<Result[]> };

/** Local Hook state; explicit reads always go through the server transport. */
export class StateRuntime implements SRStateAPI {
  private snapshot:Snapshot={global:{},session:{},message:{}};
  private readonly observers=new Set<()=>void>();
  private readonly listeners=new Set<(event:StateEvent)=>void>();
  private eventCounter=0;
  private requestCounter=0;
  constructor(private readonly transport:Transport) {}

  getSnapshot=()=>this.snapshot;
  observe=(listener:()=>void)=>{this.observers.add(listener);return()=>{this.observers.delete(listener);};};
  subscribe=(listener:(event:StateEvent)=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  private notify(){for(const listener of this.observers)listener();}
  private lookup(snapshot:Snapshot,scope:StateScope,path:string):StateValue|undefined {
    let value:StateValue|undefined=snapshot[scope];
    for(const part of path.split('.')) {
      if(!value || typeof value!=='object' || Array.isArray(value) || !Object.hasOwn(value,part))return undefined;
      value=value[part];
    }
    return value===undefined?undefined:structuredClone(value);
  }
  async getState(path:string,scope:StateScope='message'){return this.lookup(await this.transport.read(),scope,path);}
  async batchGetState(entries:Array<{path:string;scope?:StateScope}>) {
    const snapshot=await this.transport.read();
    return entries.map(entry=>({path:entry.path,scope:entry.scope??'message',value:this.lookup(snapshot,entry.scope??'message',entry.path)}));
  }
  async updateState(path:string,value:StateValue,scope:StateScope='message'){return this.batchUpdateState([{path,value,scope}]);}
  async batchUpdateState(entries:Entry[]) {
    const observed=this.eventCounter;
    const results=await this.transport.write(entries.map(entry=>({...entry,scope:entry.scope??'message'})));
    if(observed===this.eventCounter) results.forEach((result,index)=>{if(result.success && entries[index])this.replace(result.scope,result.path,entries[index]!.value);});
    return results;
  }
  async refresh() {
    const request=++this.requestCounter;
    // An event can arrive while the initial snapshot is in flight. Retry the
    // read instead of silently leaving hooks at their default values.
    while(request===this.requestCounter){
      const observed=this.eventCounter;
      const snapshot=await this.transport.read();
      if(request!==this.requestCounter)return;
      if(observed!==this.eventCounter)continue;
      this.snapshot=structuredClone(snapshot);this.notify();return;
    }
  }
  accept(event:StateEvent) {
    this.eventCounter++;
    this.replace(event.data.scope,event.data.path,event.data.value);
    for(const listener of this.listeners){try{listener(structuredClone(event));}catch{/* one creator listener must not block others */}}
  }
  private replace(scope:StateScope,path:string,value:StateValue) {
    const parts=path.split('.');
    if(parts.some(part=>!part || ['__proto__','prototype','constructor'].includes(part)))return;
    const snapshot=structuredClone(this.snapshot);
    let current:Record<string,StateValue>=snapshot[scope];
    for(const part of parts.slice(0,-1)) {
      const child=current[part];
      if(!child || typeof child!=='object' || Array.isArray(child))return;
      current=child;
    }
    current[parts[parts.length-1]!]=structuredClone(value);
    this.snapshot=snapshot;this.notify();
  }
}
