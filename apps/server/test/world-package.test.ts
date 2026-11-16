import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,mkdirSync,readdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../src/app.js';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {WorldFileStore} from '../src/infrastructure/world-files/world-file-store.js';
import {parseCard} from '../src/domain/world-card.js';
import {fakeCredentials,seedWorld} from './fixtures/db-seed.js';
import {readExportedCard,unzipFixture,zipFixture} from './zip-helpers.js';

const dirs:string[]=[];
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanups.splice(0))close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const source='export default function Main(){return null;}';
const base={spec:'world_card',spec_version:'0.1',data:{name:'雾港',characters:[{id:'p',name:'旅人',player_selectable:true}],openings:[{id:'o',name:'抵达',content:'欢迎'}]}};
function setup(){
  const dir=mkdtempSync(join(tmpdir(),'sr-package-test-'));dirs.push(dir);
  const db=openDatabase(':memory:');cleanups.push(()=>db.close());
  const files=new WorldFileStore(dir),app=createApp(db,fakeCredentials,undefined,files);
  return {dir,db,files,app};
}
const upload=(data:Buffer|string,name='world.zip')=>{
  const form=new FormData();form.set('file',new File([typeof data==='string'?data:Uint8Array.from(data)],name));
  return {method:'POST',body:form};
};
async function packaged(card:unknown=base,extra:Array<{name:string;data:string|Buffer;mode?:number}>=[]){
  return zipFixture([{name:'world.json',data:JSON.stringify(card)},...extra]);
}
async function importCard(app:ReturnType<typeof createApp>,bytes:Buffer){
  const response=await app.request('/api/v1/worlds/import',upload(bytes,'雾港世界.zip'));
  const result=await response.json() as any;
  expect(response.status,JSON.stringify(result)).toBe(201);
  return result.data.item as {id:string;data:any};
}

describe('offline world packages',()=>{
  it('keeps definitions in DB and resolves path sources, including nested paths, before inline fallbacks',async()=>{
    const {app,db,dir}=setup();
    const card={...base,data:{...base.data,cover:'sr-asset://assets/images/港口 图.webp',components:[
      {id:'Main',path:'sr-asset://components/stage/Main.tsx',component:'broken inline fallback'},
      {id:'Inline',component:source},
    ],stage_component:'Main'}};
    const bytes=await packaged(card,[{name:'components/stage/Main.tsx',data:source},{name:'assets/images/港口 图.webp',data:'image'},{name:'assets/images/cg/unreferenced.webp',data:'dynamic cg'}]);
    const world=await importCard(app,bytes);
    expect(world.data.components).toEqual(card.data.components);
    const stored=JSON.parse(String(db.prepare('SELECT components FROM worlds WHERE id=?').get(world.id)?.components));
    expect(stored).toEqual(card.data.components);
    expect(readFileSync(join(dir,'workspaces','worlds',world.id,'package','components/stage/Main.tsx'),'utf8')).toBe(source);
    const resolved=await (await app.request('/api/v1/worlds/'+world.id+'/components')).json() as any;
    expect(resolved.data).toEqual({items:[{id:'Main',component:source},{id:'Inline',component:source}],errors:{}});
    const raw=await app.request('/api/v1/worlds/'+world.id+'/source');
    expect(raw.headers.get('content-type')).toBe('application/zip');
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(bytes);
    writeFileSync(join(dir,'workspaces','worlds',world.id,'package','world.json'),'{"tampered":true}');
    db.prepare('UPDATE worlds SET name=? WHERE id=?').run('数据库中的世界',world.id);
    const exported=await app.request('/api/v1/worlds/'+world.id+'/export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-type')).toBe('application/zip');
    const archived=await unzipFixture(new Uint8Array(await exported.arrayBuffer()));
    const manifest=JSON.parse(archived.get('world.json')!.toString());
    expect(manifest.data.name).toBe('数据库中的世界');
    expect(manifest.data.components).toEqual(card.data.components);
    expect(archived.get('assets/images/cg/unreferenced.webp')!.toString()).toBe('dynamic cg');
    const reimported=await importCard(app,await zipFixture([...archived].map(([name,data])=>({name,data}))));
    expect(reimported.id).not.toBe(world.id);
    expect(reimported.data.components).toEqual(card.data.components);
  });

  it('reports missing sources without replacing them with inline components or hiding world details',async()=>{
    const {app,dir}=setup();
    const card={...base,data:{...base.data,components:[{id:'Main',path:'sr-asset://components/Main.tsx',component:source}]}};
    const world=await importCard(app,await packaged(card,[{name:'components/Main.tsx',data:source}]));
    rmSync(join(dir,'workspaces','worlds',world.id,'package','components/Main.tsx'));
    const response=await app.request('/api/v1/worlds/'+world.id+'/components');
    const result=await response.json() as any;
    expect(response.status).toBe(200);
    expect(result.data.items).toEqual([]);
    expect(result.data.errors.Main).toContain('components/Main.tsx');
    expect(result.data.errors.Main).toContain('文件不存在');
    expect((await app.request('/api/v1/worlds/'+world.id)).status).toBe(200);
    expect((await app.request('/api/v1/worlds/'+world.id+'/export')).status).toBe(422);
  });

  it('observes changed source content on the next load and reports invalid UTF-8',async()=>{
    const {app,dir}=setup();
    const card={...base,data:{...base.data,components:[{id:'Main',path:'sr-asset://components/Main.tsx'}]}};
    const world=await importCard(app,await packaged(card,[{name:'components/Main.tsx',data:source}]));
    const path=join(dir,'workspaces','worlds',world.id,'package','components/Main.tsx');
    writeFileSync(path,source+' // updated');
    const changed=await (await app.request('/api/v1/worlds/'+world.id+'/components')).json() as any;
    expect(changed.data.items[0].component).toContain('// updated');
    writeFileSync(path,Buffer.from([0xc3,0x28]));
    const broken=await (await app.request('/api/v1/worlds/'+world.id+'/components')).json() as any;
    expect(broken.data.errors.Main).toBeTruthy();
  });

  it('validates rendered HTML and Markdown entity paths without rewriting the manifest',async()=>{
    const {app}=setup();
    const card={...base,data:{...base.data,
      characters:[{...base.data.characters[0],description:'<img src="&#115;r-asset://assets/caf&eacute;.webp">'}],
      openings:[{...base.data.openings[0],content:'![A &amp; B](sr-asset://assets/a&amp;b.webp)'}],
    }};
    const world=await importCard(app,await packaged(card,[{name:'assets/café.webp',data:'cafe'},{name:'assets/a&b.webp',data:'ampersand'}]));
    expect(world.data.openings[0].content).toBe(card.data.openings[0]!.content);
    const exported=await app.request('/api/v1/worlds/'+world.id+'/export');
    expect(exported.status).toBe(200);
    const archived=await unzipFixture(new Uint8Array(await exported.arrayBuffer()));
    expect(archived.has('assets/a&b.webp')).toBe(true);
    expect(JSON.parse(archived.get('world.json')!.toString()).data.characters[0].description).toBe(card.data.characters[0]!.description);
  });

  it('exports JSON-only worlds as ZIP without a package directory',async()=>{
    const {app,dir}=setup();
    const response=await app.request('/api/v1/worlds/import',upload(JSON.stringify(base),'旧卡.json'));
    const world=(await response.json() as any).data.item;
    expect(existsSync(join(dir,'workspaces','worlds',world.id,'package'))).toBe(false);
    const exported=await app.request('/api/v1/worlds/'+world.id+'/export');
    expect(exported.headers.get('content-disposition')).toContain(encodeURIComponent('旧卡.zip'));
    const files=await unzipFixture(new Uint8Array(await exported.arrayBuffer()));
    expect([...files.keys()]).toEqual(['world.json']);
    expect(JSON.parse(files.get('world.json')!.toString()).data.name).toBe(base.data.name);
  });

  it.each([
    {cover:'sr-asset://assets/cover.webp'},
    {characters:[{...base.data.characters[0],avatar:'sr-asset://assets/avatar.webp'}]},
    {components:[{id:'Main',path:'sr-asset://components/Main.tsx',component:source}]},
    {openings:[{...base.data.openings[0],content:'![港口](sr-asset://assets/harbor.webp)'}]},
    {lorebook:{entries:[{id:'l',content:'<img src="sr-asset://assets/harbor.webp">'}]}},
    {lorebook:{entries:[{id:'l',content:'<img src="&#115;r-asset://assets/harbor.webp">'}]}},
  ])('rejects JSON local references before persisting a world: %j',async(data)=>{
    const {app,db,dir}=setup();
    const response=await app.request('/api/v1/worlds/import',upload(JSON.stringify({...base,data:{...base.data,...data}}),'world.json'));
    expect(response.status).toBe(422);
    expect((await response.json() as any).errorMessage).toContain('JSON 导入不支持');
    expect(db.prepare('SELECT count(*) AS n FROM worlds').get()?.n).toBe(0);
    expect(existsSync(join(dir,'workspaces','worlds'))?readdirSync(join(dir,'workspaces','worlds')):[]).toEqual([]);
  });

  it.each([
    [{name:'components/Main.tsx',data:source}],
    [{name:'nested/world.json',data:JSON.stringify(base)}],
    [{name:'world.json',data:JSON.stringify(base)},{name:'README.md',data:'extra'}],
    [{name:'world.json',data:JSON.stringify(base)},{name:'assets/A.webp',data:'a'},{name:'assets/a.webp',data:'b'}],
    [{name:'world.json',data:JSON.stringify(base)},{name:'assets/UP/a.webp',data:'a'},{name:'assets/up/b.webp',data:'b'}],
    [{name:'world.json',data:JSON.stringify(base)},{name:'assets/a/image.webp',data:'image'},{name:'assets/a',data:'file'}],
    [{name:'world.json',data:JSON.stringify(base)},{name:'assets/link',data:'/tmp/secret',mode:0o120777}],
    [{name:'world.json',data:JSON.stringify({...base,data:{...base.data,components:[{id:'Main',path:'sr-asset://components/missing.tsx'}]}})}],
    [{name:'world.json',data:JSON.stringify({...base,data:{...base.data,cover:'sr-asset://assets/missing.webp'}})}],
    [{name:'world.json',data:JSON.stringify({...base,data:{...base.data,components:[{id:'Main',path:'sr-asset://components/Main.tsx'}]}})},{name:'components/main.tsx',data:source}],
    [{name:'world.json',data:JSON.stringify({...base,data:{...base.data,cover:'sr-asset://assets/Images/harbor.webp'}})},{name:'assets/images/harbor.webp',data:'image'}],
  ].map(entries=>({entries})))('rejects malformed packages and removes all staged files (%#)',async({entries})=>{
    const {app,db,dir}=setup();
    const response=await app.request('/api/v1/worlds/import',upload(await zipFixture(entries)));
    expect(response.status).toBe(422);
    expect(db.prepare('SELECT count(*) AS n FROM worlds').get()?.n).toBe(0);
    expect(existsSync(join(dir,'workspaces','worlds'))?readdirSync(join(dir,'workspaces','worlds')):[]).toEqual([]);
  });

  it('rejects corrupt ZIP entries and declared oversized files',async()=>{
    const {app}=setup();
    const bytes=await packaged(base,[{name:'assets/large.bin',data:'small'}]);
    const central=Buffer.from(bytes);
    let index=central.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    index=central.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]),index+4);
    central.writeUInt32LE(300*1024*1024,index+24);
    expect((await app.request('/api/v1/worlds/import',upload(central))).status).toBe(422);
    const corrupt=Buffer.from(bytes);
    const first=corrupt.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
    corrupt.writeUInt32LE(0,first+16);
    expect((await app.request('/api/v1/worlds/import',upload(corrupt))).status).toBe(422);
  });

  it('enforces source byte limits after externalizing components into files',async()=>{
    const {app}=setup();
    const large=source+' '.repeat(800*1024);
    const components=['A','B','C'].map(id=>({id,path:'sr-asset://components/'+id+'.tsx'}));
    const card={...base,data:{...base.data,components}};
    const response=await app.request('/api/v1/worlds/import',upload(await packaged(card,components.map(item=>({name:'components/'+item.id+'.tsx',data:large})))));
    expect(response.status).toBe(422);
    expect((await response.json() as any).errorMessage).toContain('2 MiB');
    const oversized=await app.request('/api/v1/worlds/import',upload(await packaged(base,[{name:'components/too-big.tsx',data:'x'.repeat(1024*1024+1)}])));
    expect(oversized.status).toBe(422);
  });

  it('matches NFC-equivalent names while enforcing case-sensitive path segments on every filesystem',async()=>{
    const {app,files}=setup();
    const card={...base,data:{...base.data,cover:'sr-asset://assets/caf\u00e9.webp'}};
    const world=await importCard(app,await packaged(card,[
      {name:'assets/cafe\u0301.webp',data:'unicode image'},
      {name:'assets/images/harbor.webp',data:'harbor image'},
    ]));
    const resolved=await files.resolvePackageFile(world.id,'assets/caf\u00e9.webp');
    expect(readFileSync(resolved.path,'utf8')).toBe('unicode image');
    for(const path of ['assets/Caf\u00e9.webp','assets/Images/harbor.webp','assets/images/Harbor.webp']){
      await expect(files.resolvePackageFile(world.id,path)).rejects.toMatchObject({code:'ENOENT'});
    }
  });

  it('rejects path traversal and symlinks during subsequent package reads',async()=>{
    const {app,files,dir}=setup();
    const world=await importCard(app,await packaged(base,[{name:'assets/img.webp',data:'image'}]));
    for(const path of ['../source/world.zip','assets/../../source/world.zip','/assets/img.webp','assets\\img.webp','assets/%2e%2e/world.json']){
      await expect(files.resolvePackageFile(world.id,path)).rejects.toThrow();
    }
    const packageRoot=join(dir,'workspaces','worlds',world.id,'package');
    mkdirSync(join(dir,'outside'));writeFileSync(join(dir,'outside','secret'),'private');
    symlinkSync(join(dir,'outside'),join(packageRoot,'assets','escape'),'dir');
    await expect(files.resolvePackageFile(world.id,'assets/escape/secret')).rejects.toThrow();
    expect((await app.request('/api/v1/worlds/'+world.id+'/export')).status).toBe(422);
  });

  it('compensates filesystem publication after a database rollback and deletes package with world',async()=>{
    const {app,db,dir}=setup();
    db.exec("CREATE TRIGGER reject_package_tag BEFORE INSERT ON tag_assignments BEGIN SELECT RAISE(ABORT,'test'); END");
    const rejected={...base,data:{...base.data,tags:['x']}};
    expect((await app.request('/api/v1/worlds/import',upload(await packaged(rejected)))).status).toBe(422);
    expect(readdirSync(join(dir,'workspaces','worlds'))).toEqual([]);
    db.exec('DROP TRIGGER reject_package_tag');
    const world=await importCard(app,await packaged());
    expect((await app.request('/api/v1/worlds/'+world.id,{method:'DELETE'})).status).toBe(200);
    expect(existsSync(join(dir,'workspaces','worlds',world.id))).toBe(false);
  });

  it('rejects absent or empty sources while preserving inline-only fixture IDs',async()=>{
    for(const component of [{id:'Main'},{id:'Main',path:''},{id:'Main',path:'https://host/Main.tsx'},{id:'Main',path:'sr-asset://assets/Main.tsx'}]){
      expect(()=>parseCard({...base,data:{...base.data,components:[component]}})).toThrow();
    }
    const {app,db}=setup();
    seedWorld(db,'w',{...base,data:{...base.data,components:[{id:'Main',component:source}]}});
    const result=await (await app.request('/api/v1/worlds/w/components')).json() as any;
    expect(result.data).toEqual({items:[{id:'Main',component:source}],errors:{}});
    const exported=await readExportedCard(await app.request('/api/v1/worlds/w/export'));
    expect(exported.data.components).toEqual([{id:'Main',component:source}]);
    expect((await app.request('/api/v1/worlds/missing/components')).status).toBe(404);
  });

  it('preserves model-independent definitions in manifest-only exports',async()=>{
    const {app}=setup();
    const response=await app.request('/api/v1/worlds/import',upload(JSON.stringify(base),'world.json'));
    const id=(await response.json() as any).data.item.id;
    const manifest=await readExportedCard(await app.request('/api/v1/worlds/'+id+'/export'));
    expect(manifest).toMatchObject(base);
    expect(manifest).not.toHaveProperty('success');
    expect(manifest.data).not.toHaveProperty('defaultApiModelConfigId');
  });
});
