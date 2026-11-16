import { constants, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { open as openZip, type Entry, type ZipFile as InputZip } from 'yauzl';
import { ZipFile } from 'yazl';
import { decodeHTMLAttribute, decodeHTMLStrict } from 'entities';
import { parseSRAssetUri, validatePackagePath } from '@sillyrealms/sdk/assets';
import { CardError, parseCard } from '../../domain/world-card.js';
import { WorldFileStore, resolvePackagePath, WORLD_JSON_LIMIT, WORLD_ZIP_LIMIT, type PackageFile } from './world-file-store.js';

type Card = ReturnType<typeof parseCard>;
type Components = NonNullable<Card['data']['components']>;
type FileResolver = (path:string) => Promise<PackageFile>;
const MAX_ENTRIES=10000, MAX_EXPANDED=1024*1024*1024, MAX_FILE=WORLD_ZIP_LIMIT;
const COMPONENT_LIMIT=1024*1024, COMPONENT_TOTAL=2*1024*1024;
type ResourceReference={uri:string;location:string};

function json(bytes:Uint8Array):unknown {
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch {throw new CardError('$','Invalid UTF-8 JSON');}
}
function readableReason(error:unknown):string {
  if(error instanceof CardError)return error.reason;
  const code=(error as NodeJS.ErrnoException)?.code;
  if(code==='ENOENT')return '文件不存在';
  if(code==='EACCES'||code==='EPERM')return '文件无法读取';
  return error instanceof Error ? error.message : '文件读取失败';
}

/** Inspect declared display resources; never scan arbitrary component source or prompts. */
function resourceReferences(card:Card):ResourceReference[] {
  const references:ResourceReference[]=[];
  const add=(value:string|undefined,location:string)=>{
    if(value && /^sr-asset:/i.test(value.trim()))references.push({uri:value,location});
  };
  add(card.data.cover,'$.data.cover');
  const prose=(value:string|undefined,location:string)=>{
    if(!value)return;
    // Code examples are not resources. Markdown/HTML display attributes are checked separately.
    const text=value.replace(/(^|\n)(?:\x60{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n(?:\x60{3,}|~{3,})[^\n]*(?=\n|$)|$)/g,'')
      .replace(/\x60[^\x60\n]*\x60/g,'');
    for(const match of text.matchAll(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi))add(decodeHTMLAttribute(match[1]??match[2]??match[3]??''),location);
    for(const match of text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g))add(decodeHTMLStrict(match[1]??match[2]??''),location);
  };
  card.data.characters.forEach((item,index)=>{
    add(item.avatar,'$.data.characters['+index+'].avatar');
    prose(item.description,'$.data.characters['+index+'].description');
  });
  card.data.openings.forEach((item,index)=>prose(item.content,'$.data.openings['+index+'].content'));
  card.data.lorebook?.entries.forEach((item,index)=>prose(item.content,'$.data.lorebook.entries['+index+'].content'));
  card.data.message_render?.rules?.forEach((item,index)=>{
    if(item.replacement.type!=='component')prose(item.replacement.content,'$.data.message_render.rules['+index+'].replacement.content');
  });
  return references;
}

async function readComponent(component:Components[number], resolve:FileResolver):Promise<string> {
  if(component.path===undefined)return component.component!;
  const relative=parseSRAssetUri(component.path,'components');
  const file=await resolve(relative);
  if(file.stat.size>COMPONENT_LIMIT)throw new Error('组件源码超过 1 MiB');
  const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>COMPONENT_LIMIT)throw new Error('组件源码超过 1 MiB 或不是常规文件');
    const bytes=Buffer.alloc(COMPONENT_LIMIT+1);
    let size=0;
    while(size<bytes.length){const result=await handle.read(bytes,size,bytes.length-size,size);if(!result.bytesRead)break;size+=result.bytesRead;}
    if(size>COMPONENT_LIMIT)throw new Error('组件源码超过 1 MiB');
    const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));
    if(!source.trim())throw new Error('组件源码为空');
    return source;
  }finally{await handle.close();}
}

export async function resolveWorldComponents(files:WorldFileStore, id:string, components:Components=[]) {
  const items:Array<{id:string;component:string}>=[],errors:Record<string,string>=Object.create(null);
  let size=0;
  for(const item of components){
    try {
      const source=await readComponent(item,path=>files.resolvePackageFile(id,path));
      size+=Buffer.byteLength(source,'utf8');
      if(size>COMPONENT_TOTAL)throw new Error('组件源码总量超过 2 MiB');
      items.push({id:item.id,component:source});
    }catch(error){
      errors[item.id]='组件 '+item.id+' 加载失败'+(item.path?'（'+item.path+'）':'')+'：'+readableReason(error);
    }
  }
  return {items,errors};
}

async function validateReferences(card:Card, resolve:FileResolver|null):Promise<void> {
  let total=0;
  for(const [index,item] of (card.data.components??[]).entries()){
    const location='$.data.components['+index+']';
    if(item.path!==undefined&&!resolve)throw new CardError(location+'.path','JSON 导入不支持包内组件，请使用 ZIP');
    try {
      const source=await readComponent(item,resolve??(async()=>{throw new Error('世界没有资源包');}));
      total+=Buffer.byteLength(source,'utf8');
      if(total>COMPONENT_TOTAL)throw new Error('组件源码总量超过 2 MiB');
    }catch(error){throw new CardError(location+'.path',readableReason(error));}
  }
  for(const item of resourceReferences(card)){
    if(!resolve)throw new CardError(item.location,'JSON 导入不支持 sr-asset 包内资源，请使用 ZIP');
    let path:string;
    try {path=parseSRAssetUri(item.uri,'assets');}
    catch {throw new CardError(item.location,'无效的包内资源地址：'+item.uri);}
    // Regex replacements may construct a resource name using captured groups.
    if(/\$(?:\d+|<[^>]+>)/.test(path))continue;
    try {await resolve(path);}
    catch(error){throw new CardError(item.location,path+'：'+readableReason(error));}
  }
}

function archive(path:string):Promise<InputZip> {
  return new Promise((resolve,reject)=>openZip(path,{lazyEntries:true,decodeStrings:true,validateEntrySizes:true,strictFileNames:true},(error,value)=>error?reject(error):resolve(value!)));
}
function entryStream(zip:InputZip,entry:Entry):Promise<Readable> {
  return new Promise((resolve,reject)=>zip.openReadStream(entry,(error,value)=>error?reject(error):resolve(value!)));
}
async function extract(archivePath:string, directory:string):Promise<void> {
  const zip=await archive(archivePath);
  let count=0,total=0,manifest=false;
  const seen=new Set<string>(),names=new Map<string,string>(),files=new Set<string>(),directories=new Set<string>();
  await new Promise<void>((resolve,reject)=>{
    let settled=false;
    const fail=(error:unknown)=>{if(settled)return;settled=true;zip.close();reject(error);};
    zip.on('error',fail);
    zip.on('end',()=>{if(settled)return;settled=true;if(manifest)resolve();else reject(new Error('ZIP 根目录缺少 world.json'));});
    zip.on('entry',(entry:Entry)=>{
      void (async()=>{
        if(++count>MAX_ENTRIES)throw new Error('ZIP 条目超过 10000');
        if(entry.isEncrypted())throw new Error('不支持加密 ZIP');
        const directoryEntry=entry.fileName.endsWith('/');
        const name=validatePackagePath(directoryEntry?entry.fileName.slice(0,-1):entry.fileName);
        if(name!=='world.json'&&!name.startsWith('assets/')&&!name.startsWith('components/')&&!(directoryEntry&&['assets','components'].includes(name)))throw new Error('ZIP 只允许根 world.json、components/ 和 assets/');
        if(name==='world.json'&&directoryEntry)throw new Error('world.json 必须是文件');
        const mode=(entry.externalFileAttributes>>>16)&0o170000;
        if(mode && mode!==(directoryEntry?0o040000:0o100000))throw new Error('ZIP 不支持符号链接或特殊文件');
        const key=name.normalize('NFC').toLowerCase();
        if(seen.has(key))throw new Error('ZIP 存在重复路径：'+name);
        seen.add(key);
        const segments=name.split('/');
        for(let i=1;i<=segments.length;i++){
          const prefix=segments.slice(0,i).join('/'),normalized=prefix.normalize('NFC').toLowerCase();
          const prior=names.get(normalized);
          if(prior!==undefined&&prior!==prefix)throw new Error('ZIP 路径大小写或 Unicode 冲突：'+name);
          if(i<segments.length||directoryEntry){
            if(files.has(normalized))throw new Error('ZIP 文件与目录冲突：'+name);
            directories.add(normalized);
          }
          names.set(normalized,prefix);
          if(names.size>MAX_ENTRIES)throw new Error('ZIP 文件与目录总数超过 10000');
        }
        if(!directoryEntry){
          if(directories.has(key))throw new Error('ZIP 文件与目录冲突：'+name);
          files.add(key);
        }
        const limit=name==='world.json'?WORLD_JSON_LIMIT:name.startsWith('components/')?COMPONENT_LIMIT:MAX_FILE;
        if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize>limit)throw new Error('ZIP 文件超过大小限制：'+name);
        total+=entry.uncompressedSize;
        if(total>MAX_EXPANDED)throw new Error('ZIP 解压内容超过 1 GiB');
        const target=join(directory,...segments);
        if(directoryEntry){
          if(entry.uncompressedSize!==0)throw new Error('ZIP 目录包含非法数据');
          await mkdir(target,{recursive:true,mode:0o700});
          return;
        }
        await mkdir(dirname(target),{recursive:true,mode:0o700});
        let bytes=0,crc=0;
        const guard=new Transform({transform(chunk:Buffer,_encoding,callback){
          bytes+=chunk.length;
          if(bytes>limit||bytes>entry.uncompressedSize){callback(new Error('ZIP 实际解压大小无效：'+name));return;}
          crc=crc32(chunk,crc);
          callback(null,chunk);
        }});
        await pipeline(await entryStream(zip,entry),guard,createWriteStream(target,{flags:'wx',mode:0o600}));
        if(bytes!==entry.uncompressedSize||(crc>>>0)!==(entry.crc32>>>0))throw new Error('ZIP 文件校验失败：'+name);
        if(name==='world.json')manifest=true;
      })().then(()=>{if(!settled)zip.readEntry();},fail);
    });
    zip.readEntry();
  });
}

export async function importWorldFile(files:WorldFileStore,id:string,file:File) {
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(!/\.zip$/i.test(file.name)){
    const card=parseCard(json(bytes));
    await validateReferences(card,null);
    const saved=await files.save(id,bytes,file.name);
    return {card,saved};
  }
  const saved=await files.save(id,bytes,file.name);
  const staged=await files.createPackageStage(id);
  try {
    const source=await files.resolveSourceFile(id,saved.path);
    await extract(source.path,staged);
    const manifest=await resolvePackagePath(staged,'world.json');
    const card=parseCard(json(await readFile(manifest.path)));
    await validateReferences(card,path=>resolvePackagePath(staged,path));
    await files.publishPackage(id,staged);
    return {card,saved};
  }catch(error){
    if(error instanceof CardError)throw error;
    throw new CardError('$','ZIP 导入失败：'+readableReason(error));
  }finally{await rm(staged,{recursive:true,force:true});}
}

/** Stage a complete export before replying, so failures never produce a successful broken ZIP. */
export async function exportWorldPackage(files:WorldFileStore,id:string,card:Card):Promise<{path:string;cleanup:()=>Promise<void>}> {
  await validateReferences(card,path=>files.resolvePackageFile(id,path));
  const names=(await files.listPackageFiles(id)).filter(name=>name!=='world.json');
  const stage=await files.createExportStage();
  const cleanup=()=>rm(stage,{recursive:true,force:true});
  try {
    let size=0;
    for(const name of names){
      const file=await files.resolvePackageFile(id,name);
      if(file.stat.size>MAX_FILE||size+file.stat.size>MAX_EXPANDED)throw new Error('世界资源包超过大小限制');
      const copy=join(stage,'package',...name.split('/'));
      await mkdir(dirname(copy),{recursive:true,mode:0o700});
      let copied=0;
      const guard=new Transform({transform(chunk:Buffer,_encoding,callback){
        copied+=chunk.length;size+=chunk.length;
        if(copied>MAX_FILE||size>MAX_EXPANDED){callback(new Error('世界资源包超过大小限制'));return;}
        callback(null,chunk);
      }});
      const input=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try {
        const current=await input.stat();
        if(!current.isFile()||current.dev!==file.stat.dev||current.ino!==file.stat.ino)throw new Error('资源文件在导出期间发生变化，请重试');
        await pipeline(input.createReadStream({autoClose:false}),guard,createWriteStream(copy,{flags:'wx',mode:0o600}));
      }finally {await input.close();}
    }
    const path=join(stage,'world.zip'),zip=new ZipFile();
    const manifest=Buffer.from(JSON.stringify(card)+'\n','utf8');
    if(manifest.length>WORLD_JSON_LIMIT)throw new Error('导出 world.json 超过 10 MiB');
    zip.addBuffer(manifest,'world.json');
    for(const name of names)zip.addFile(join(stage,'package',...name.split('/')),name,{
      compress:!/\.(?:webp|avif|png|jpe?g|gif|mp[34]|ogg|webm|woff2?|zip)$/i.test(name),
    });
    const output=createWriteStream(path,{flags:'wx',mode:0o600});
    zip.on('error',(error:Error)=>output.destroy(error));
    const writing=pipeline(zip.outputStream,output);
    zip.end();
    await writing;
    return {path,cleanup};
  }catch(error){await cleanup();throw error;}
}

export function exportReadStream(path:string,cleanup:()=>Promise<void>):Readable {
  const stream=createReadStream(path);
  stream.once('close',()=>{void cleanup().catch(()=>{});});
  return stream;
}
