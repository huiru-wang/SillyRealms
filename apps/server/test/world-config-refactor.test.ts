import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Api, AssistantMessageEvent, Model } from '@earendil-works/pi-ai';
import type { ModelGateway } from '../src/agent/model/pi-gateway.js';
import { openDatabase } from '../src/infrastructure/database/database.js';
import { WorldFileStore } from '../src/infrastructure/world-files/world-file-store.js';
import { createApp } from '../src/app.js';
import { configureWorldModel, fakeCredentials, seedModel } from './fixtures/db-seed.js';

const folders:string[]=[];
afterEach(()=>{for(const folder of folders.splice(0)) rmSync(folder,{recursive:true,force:true});});
const post=(body:unknown)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const patch=(body:unknown)=>({method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const sample={spec:'world_card',spec_version:'0.1',data:{
  name:'新世界',summary:'独立配置',characters:[{id:'p',name:'玩家',player_selectable:true}],
  openings:[{id:'o',name:'开局',content:'起点'}],
  lorebook:{entries:[{id:'l',content:'远处有港口'}]},
}};
const upload=(raw:string,name='input.json')=>{const form=new FormData();form.set('file',new File([raw],name));return {method:'POST',body:form};};
function setup(gateway?:ModelGateway) {
  const dir=mkdtempSync(join(tmpdir(),'sr-config-refactor-'));folders.push(dir);
  const db=openDatabase(':memory:');
  const files=new WorldFileStore(dir);
  const app=createApp(db,fakeCredentials,gateway,files);
  return {db,app,dir,files};
}

it('holds app defaults, stores exact source bytes, and copies world defaults into isolated sessions',async()=>{
  const {db,app,dir}=setup();
  try {
    const defaults=await (await app.request('/api/v1/app-settings')).json() as any;
    expect(defaults.data.item).toMatchObject({defaultPresetId:'sr-default-preset',defaultApiModelConfigId:null});
    const raw=' {\n  "spec":"world_card",\n  "spec_version":"0.1",\n  "data":'+JSON.stringify(sample.data)+'\n}\n';
    const imported=await app.request('/api/v1/worlds/import',upload(raw));
    expect(imported.status).toBe(201);
    const world=(await imported.json() as any).data.item;
    const id=world.id as string;
    expect(world.defaultApiModelConfigId).toBeNull();
    const source=await app.request('/api/v1/worlds/'+id+'/source');
    expect(source.status).toBe(200);
    expect(await source.text()).toBe(raw);
    expect(existsSync(join(dir,'workspaces','worlds',id,'source','input.json'))).toBe(true);
    expect(db.prepare("SELECT name FROM pragma_table_info('worlds') WHERE name='data_json'").get()).toBeUndefined();
    expect(JSON.parse(String(db.prepare('SELECT characters_json FROM worlds WHERE id=?').get(id)?.characters_json))).toEqual(sample.data.characters);
    const missing=await app.request('/api/v1/sessions',post({worldId:id,openingId:'o',userCharacterId:'p'}));
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({code:'WORLD_CONFIG_INCOMPLETE'});

    seedModel(db,'model-a');seedModel(db,'model-b');
    const savedDefault=await app.request('/api/v1/app-settings',patch({defaultApiModelConfigId:'model-a'}));
    expect(savedDefault.status).toBe(200);
    expect((await (await app.request('/api/v1/worlds/'+id)).json() as any).data.item.defaultApiModelConfigId).toBeNull();
    expect((await app.request('/api/v1/worlds/'+id,patch({defaultApiModelConfigId:'model-a'}))).status).toBe(200);
    const first=await app.request('/api/v1/sessions',post({worldId:id,openingId:'o',userCharacterId:'p'}));
    expect(first.status).toBe(201);
    const s1=(await first.json() as any).data.item;
    expect(s1).toMatchObject({presetId:'sr-default-preset',apiModelConfigId:'model-a'});

    const importedAgain=await app.request('/api/v1/worlds/import',upload(raw));
    const world2=(await importedAgain.json() as any).data.item;
    expect(world2.defaultApiModelConfigId).toBe('model-a');

    expect((await app.request('/api/v1/worlds/'+id,patch({defaultApiModelConfigId:'model-b'}))).status).toBe(200);
    const s2=(await (await app.request('/api/v1/sessions',post({worldId:id,openingId:'o',userCharacterId:'p'}))).json() as any).data.item;
    expect(s2.apiModelConfigId).toBe('model-b');
    expect((await (await app.request('/api/v1/sessions/'+s1.id)).json() as any).data.apiModelConfigId).toBe('model-a');
    const updated=await app.request('/api/v1/sessions/'+s1.id,patch({apiModelConfigId:'model-b'}));
    expect(updated.status).toBe(200);
    expect((await (await app.request('/api/v1/sessions/'+s1.id)).json() as any).data.apiModelConfigId).toBe('model-b');

    expect((await app.request('/api/v1/presets/sr-default-preset',{method:'DELETE'})).status).toBe(409);
    const modelRemoval=await app.request('/api/v1/api-model-configs/model-b',{method:'DELETE'});
    expect(modelRemoval.status).toBe(409);
    expect(await modelRemoval.json()).toMatchObject({code:'CONFIG_IN_USE'});
    const exported=await (await app.request('/api/v1/worlds/'+id+'/export')).json() as any;
    expect(exported.data.characters).toEqual(sample.data.characters);
    expect(exported.data.lorebook).toEqual(sample.data.lorebook);
    expect(exported.data).not.toHaveProperty('defaultApiModelConfigId');
    expect(exported.data).not.toHaveProperty('defaultPresetId');
    expect((await app.request('/api/v1/worlds/'+id,{method:'DELETE'})).status).toBe(200);
    expect(existsSync(join(dir,'workspaces','worlds',id))).toBe(false);
  } finally {db.close();}
});


it('rejects tampered original world source without mutating the structured card',async()=>{
  const {db,app,dir}=setup();
  try {
    const imported=await app.request('/api/v1/worlds/import',upload(JSON.stringify(sample)));
    expect(imported.status).toBe(201);
    const id=(await imported.json() as any).data.item.id;
    writeFileSync(join(dir,'workspaces','worlds',id,'source','input.json'),'{"tampered":true}');
    const res=await app.request('/api/v1/worlds/'+id+'/source');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({code:'WORLD_CORRUPT'});
    const reconstructed=await app.request('/api/v1/worlds/'+id+'/export');
    expect(reconstructed.status).toBe(200);
    expect((await reconstructed.json() as any).data.name).toBe(sample.data.name);
  } finally {db.close();}
});

it('keeps the original UTF-8 filename for source storage and normalized exports',async()=>{
  const {db,app,dir,files}=setup();
  const originalName='庄园 世界卡 v1.5.json';
  const raw=JSON.stringify(sample,null,2)+'\n';
  try {
    const response=await app.request('/api/v1/worlds/import',upload(raw,originalName));
    expect(response.status).toBe(201);
    const id=(await response.json() as any).data.item.id as string;
    expect(existsSync(join(dir,'workspaces','worlds',id,'source',originalName))).toBe(true);
    expect(db.prepare('SELECT source_file_path FROM worlds WHERE id=?').get(id)?.source_file_path).toBe(files.sourcePath(id,originalName));
    const encoded=encodeURIComponent(originalName);
    const source=await app.request('/api/v1/worlds/'+id+'/source');
    expect(source.status).toBe(200);
    expect(source.headers.get('content-disposition')).toContain("filename*=UTF-8''"+encoded);
    expect(await source.text()).toBe(raw);
    const exported=await app.request('/api/v1/worlds/'+id+'/export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toContain("filename*=UTF-8''"+encoded);
    expect((await exported.json() as any).data.name).toBe(sample.data.name);
  } finally {db.close();}
});

it('rejects unsafe names and still reads legacy original.json source paths',async()=>{
  const {db,app,dir,files}=setup();
  try{
    const body=JSON.stringify(sample);
    for(const name of ['../unsafe.json','nested/path.json','bad\\\\name.json','not-json.txt']){
      expect(()=>files.sourcePath(randomUUID(),name)).toThrow();
      const response=await app.request('/api/v1/worlds/import',upload(body,name));
      expect(response.status).toBe(422);
    }
    const response=await app.request('/api/v1/worlds/import',upload(body));
    const id=(await response.json() as any).data.item.id as string;
    const sourceDir=join(dir,'workspaces','worlds',id,'source');
    renameSync(join(sourceDir,'input.json'),join(sourceDir,'original.json'));
    db.prepare('UPDATE worlds SET source_file_path=? WHERE id=?').run(files.sourcePath(id),id);
    const legacy=await app.request('/api/v1/worlds/'+id+'/source');
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe(body);
    expect((await app.request('/api/v1/worlds/'+id+'/export')).status).toBe(200);
  } finally {db.close();}
});

it('cleans only orphaned UUID world folders at startup',async()=>{
  const {db,files,dir}=setup();
  try {
    const active=randomUUID(), orphan=randomUUID();
    await files.save(active,new TextEncoder().encode('{}'));
    await files.save(orphan,new TextEncoder().encode('{}'));
    expect(await files.cleanupOrphans(new Set([active]))).toBe(1);
    expect(existsSync(join(dir,'workspaces','worlds',active))).toBe(true);
    expect(existsSync(join(dir,'workspaces','worlds',orphan))).toBe(false);
  } finally {db.close();}
});

it('rolls back world rows and their source files after failed tag persistence',async()=>{
  const {db,app,dir}=setup();
  try {
    db.exec("CREATE TRIGGER reject_tag BEFORE INSERT ON tag_assignments BEGIN SELECT RAISE(ABORT,'test'); END");
    const form=upload(JSON.stringify({...sample,data:{...sample.data,tags:['x']}}));
    expect((await app.request('/api/v1/worlds/import',form)).status).toBe(422);
    expect(db.prepare('SELECT count(*) AS n FROM worlds').get()?.n).toBe(0);
    const { readdirSync }=await import('node:fs');
    const folder=join(dir,'workspaces','worlds');
    expect(existsSync(folder)?readdirSync(folder):[]).toEqual([]);
  } finally {db.close();}
});

it('uses session-selected model for each run even after world defaults change',async()=>{
  const calls:string[]=[];
  const model:Model<Api>={
    id:'m',name:'Fake',provider:'fake',api:'openai-completions',baseUrl:'http://localhost',
    reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096,
    cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
  };
  const gateway:ModelGateway={
    resolve:(_provider,id)=>({...model,id}),
    toolVerified:()=>true,
    stream:(selected)=>({
      async *[Symbol.asyncIterator]() {
        calls.push(selected.id);
        const text='回答';
        yield {type:'text_delta',delta:text,contentIndex:0,partial:{} as never} as AssistantMessageEvent;
        yield {type:'done',reason:'stop',message:{
          role:'assistant',content:[{type:'text',text}],api:'openai-completions',
          provider:'fake',model:selected.id,stopReason:'stop',timestamp:Date.now(),
          usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        }} as AssistantMessageEvent;
      },
    }),
  };
  const {db,app}=setup(gateway);
  try {
    const imported=await app.request('/api/v1/worlds/import',upload(JSON.stringify(sample)));
    const id=(await imported.json() as any).data.item.id;
    configureWorldModel(db,id,'model-a');
    db.prepare('UPDATE api_model_configs SET model_id=? WHERE id=?').run('model-a','model-a');
    const session=await app.request('/api/v1/sessions',post({worldId:id,openingId:'o',userCharacterId:'p'}));
    expect(session.status).toBe(201);
    const first=(await session.json() as any).data.item;
    expect((await app.request('/api/v1/worlds/'+id,patch({defaultApiModelConfigId:'model-b'}))).status).toBe(422);
    seedModel(db,'model-b');
    db.prepare('UPDATE api_model_configs SET model_id=? WHERE id=?').run('model-b','model-b');
    expect((await app.request('/api/v1/worlds/'+id,patch({defaultApiModelConfigId:'model-b'}))).status).toBe(200);
    let tip=first.tipEntryId as string;
    for(const [index,expected] of ['model-a','model-b'].entries()) {
      if(index) expect((await app.request('/api/v1/sessions/'+first.id,patch({apiModelConfigId:'model-b'}))).status).toBe(200);
      const sent=await app.request('/api/v1/sessions/'+first.id+'/runs',post({text:'继续',requestId:crypto.randomUUID(),expectedTipEntryId:tip}));
      expect(sent.status).toBe(202);
      const runId=(await sent.json() as any).data.runId;
      let result:any;
      for(let attempt=0;attempt<100;attempt++){
        result=(await (await app.request('/api/v1/sessions/'+first.id+'/runs/'+runId)).json() as any).data;
        if(result?.status==='completed')break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(result?.status).toBe('completed');
      tip=result.tipEntryId;
      expect(calls[index]).toBe(expected);
    }
  } finally {db.close();}
});
