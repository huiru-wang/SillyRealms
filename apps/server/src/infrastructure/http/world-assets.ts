import {createHash} from 'node:crypto';
import {constants, type Stats} from 'node:fs';
import {open, type FileHandle} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {Hono} from 'hono';
import {getMimeType} from 'hono/utils/mime';
import {validatePackagePath} from '@sillyrealms/sdk/assets';
import type {WorldFileStore} from '../world-files/world-file-store.js';

type ByteRange = {start:number;end:number};
const mediaTypes:Record<string,string>={
  wav:'audio/wav',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/ogg',flac:'audio/flac',
  m4a:'audio/mp4',aac:'audio/aac',mp3:'audio/mpeg',mp4:'video/mp4',m4v:'video/mp4',
  mov:'video/quicktime',ogv:'video/ogg',webm:'video/webm',
  woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',eot:'application/vnd.ms-fontobject',
};
const fingerprint=(stat:Stats)=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');

/** Multiple ranges are deliberately ignored; normal browser media seeks use one range. */
function byteRange(header:string|undefined,size:number):ByteRange|'unsatisfiable'|undefined {
  if(!header||header.includes(','))return;
  const match=/^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if(!match||(!match[1]&&!match[2]))return;
  if(size===0)return 'unsatisfiable';
  if(!match[1]){
    const length=Number(match[2]);
    if(length===0)return 'unsatisfiable';
    return {start:Math.max(0,size-length),end:size-1};
  }
  const start=Number(match[1]),end=match[2]?Math.min(Number(match[2]),size-1):size-1;
  if(start>=size||end<start)return 'unsatisfiable';
  return {start,end};
}
function notModified(request:Request,etag:string,modified:number):boolean {
  const tags=request.headers.get('if-none-match');
  if(tags!==null)return tags.split(',').some(tag=>tag.trim()==='*'||tag.trim().replace(/^W\//,'')===etag);
  const since=request.headers.get('if-modified-since');
  return since!==null&&Math.floor(modified/1000)*1000<=Date.parse(since);
}
function rangeMatches(request:Request,etag:string,modified:number):boolean {
  const value=request.headers.get('if-range');
  if(value===null)return true;
  if(value.startsWith('"')||value.startsWith('W/'))return value===etag;
  // Recent timestamps are not strong enough to combine byte ranges safely.
  return Date.now()-modified>=60000&&Date.parse(value)===Math.floor(modified/1000)*1000;
}

/** Public, credential-free package media on the isolated renderer origin. */
export function worldAssetRoutes(files:WorldFileStore,worldExists:(id:string)=>boolean=()=>true):Hono {
  const app=new Hono();
  const digests=new Map<string,{signature:string;etag:string}>();
  async function digest(path:string,handle:FileHandle,stat:Stats):Promise<string>{
    const signature=fingerprint(stat),cached=digests.get(path);
    if(cached?.signature===signature)return cached.etag;
    const hash=createHash('sha256');
    for await(const chunk of handle.createReadStream({start:0,autoClose:false}))hash.update(chunk);
    if(fingerprint(await handle.stat())!==signature)throw Error('ASSET_CHANGED_DURING_READ');
    const etag='"'+hash.digest('hex')+'"';
    digests.delete(path);digests.set(path,{signature,etag});
    if(digests.size>512)digests.delete(digests.keys().next().value!);
    return etag;
  }
  app.all('*',async c=>{
    if(!['GET','HEAD'].includes(c.req.method))return c.text('Not Found',404);
    let handle:FileHandle|undefined,streaming=false;
    try{
      const match=/^\/([0-9a-f-]{36})\/(assets\/.+)$/i.exec(c.req.path.replace(/^\/world-assets/,''));
      if(!match||/%(?:2f|5c)/i.test(match[2]!)||!worldExists(match[1]!))return c.text('Not Found',404);
      const relative=validatePackagePath(decodeURIComponent(match[2]!),'assets');
      const file=await files.resolvePackageFile(match[1]!,relative);
      handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=await handle.stat();
      if(!stat.isFile()||stat.dev!==file.stat.dev||stat.ino!==file.stat.ino)throw Error('INVALID_ASSET_FILE');
      const etag=await digest(file.path,handle,stat);
      const type=mediaTypes[relative.split('.').at(-1)!.toLowerCase()]??getMimeType(relative)??'application/octet-stream';
      const headers=new Headers({
        'Content-Type':type,
        'Cache-Control':'private, no-cache',
        'ETag':etag,
        'Last-Modified':stat.mtime.toUTCString(),
        'Accept-Ranges':'bytes',
        'X-Content-Type-Options':'nosniff',
        // A document opened directly from a package cannot become a privileged page.
        'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; sandbox",
      });
      if(type.startsWith('font/')||/\.(?:woff2?|ttf|otf|eot)$/i.test(relative)){
        headers.set('Access-Control-Allow-Origin','*');
      }
      if(notModified(c.req.raw,etag,stat.mtimeMs))return new Response(null,{status:304,headers});
      const range=c.req.method==='GET'&&rangeMatches(c.req.raw,etag,stat.mtimeMs)
        ?byteRange(c.req.header('range'),stat.size):undefined;
      if(range==='unsatisfiable'){
        headers.set('Content-Range','bytes */'+stat.size);
        headers.set('Content-Length','0');
        return new Response(null,{status:416,headers});
      }
      const start=range?.start??0,end=range?.end??stat.size-1;
      headers.set('Content-Length',String(range?end-start+1:stat.size));
      if(range)headers.set('Content-Range','bytes '+start+'-'+end+'/'+stat.size);
      if(c.req.method==='HEAD'||stat.size===0)return new Response(null,{status:200,headers});
      const source=handle.createReadStream({start,end,autoClose:true});
      const aborted=()=>source.destroy();
      c.req.raw.signal.addEventListener('abort',aborted,{once:true});
      source.once('close',()=>c.req.raw.signal.removeEventListener('abort',aborted));
      streaming=true;
      return new Response(Readable.toWeb(source) as ReadableStream<Uint8Array>,{status:range?206:200,headers});
    }catch{
      c.header('Cache-Control','no-store');
      return c.text('Resource not found or unavailable',404);
    }finally{
      if(!streaming)await handle?.close().catch(()=>{});
    }
  });
  return app;
}
