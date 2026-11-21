import { constants, createWriteStream } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { open as openZip, type Entry, type ZipFile as InputZip } from 'yauzl';
import { ZipFile } from 'yazl';
import { validatePackagePath } from '@sillyrealms/sdk/assets';
import { AppError } from '../../errors.js';
import { parseCardBytes } from './parser.js';
import type { WorldCard } from './validation.js';
import { COMPONENT_LIMIT, readableReason, validateAssets } from './assets.js';
import { WorldFileStore, resolvePackagePath, WORLD_JSON_LIMIT, WORLD_ZIP_LIMIT, type ImportFileStage } from './files.js';

const MAX_ENTRIES=10000, MAX_EXPANDED=1024*1024*1024, MAX_FILE=WORLD_ZIP_LIMIT;

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

export async function readImportPackage(stage: ImportFileStage): Promise<WorldCard> {
  const source = join(stage.root, 'source', 'original.' + stage.format);
  if (stage.format === 'json') {
    const card = parseCardBytes(await readFile(source));
    await validateAssets(card, null);
    return card;
  }
  const root = join(stage.root, 'package');
  try {
    await extract(source, root);
    const manifest = await resolvePackagePath(root, 'world.json');
    const card = parseCardBytes(await readFile(manifest.path));
    await validateAssets(card, path => resolvePackagePath(root, path));
    return card;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_WORLD_PACKAGE', readableReason(error));
  }
}

/** Stage a complete export before replying, so failures never produce a successful broken ZIP. */
export async function buildWorldPackage(files:WorldFileStore,id:string,card:WorldCard):Promise<{path:string;cleanup:()=>Promise<void>}> {
  await validateAssets(card,path=>files.resolvePackageFile(id,path));
  const names=(await files.listPackageFiles(id)).filter(name=>name!=='world.json');
  const stage=await files.createTemporaryDirectory('export');
  const cleanup=()=>files.removeTemporaryDirectory(stage);
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
