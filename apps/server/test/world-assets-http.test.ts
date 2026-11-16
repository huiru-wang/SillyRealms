import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorldFileStore} from '../src/infrastructure/world-files/world-file-store.js';
import {createStageApp} from '../src/infrastructure/http/stage-assets.js';

const worldId='b6ddc494-bf83-4ced-a841-3846b0085391',folders:string[]=[];
afterEach(async()=>{await Promise.all(folders.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function setup(){
  const directory=await mkdtemp(join(tmpdir(),'sr-world-assets-'));folders.push(directory);
  const packageDir=join(directory,'workspaces','worlds',worldId,'package');
  await mkdir(join(packageDir,'assets','images'),{recursive:true});
  await mkdir(join(packageDir,'assets','audio'),{recursive:true});
  await mkdir(join(packageDir,'assets','fonts'),{recursive:true});
  await mkdir(join(packageDir,'components'),{recursive:true});
  await writeFile(join(packageDir,'assets','images','海 港.webp'),'0123456789');
  await writeFile(join(packageDir,'assets','audio','sea.wav'),'abcdefghij');
  await writeFile(join(packageDir,'assets','fonts','story.woff2'),'font');
  await writeFile(join(packageDir,'assets','empty.txt'),'');
  await writeFile(join(packageDir,'components','Main.tsx'),'export default function Main(){return null}');
  await writeFile(join(packageDir,'world.json'),'{}');
  const app=createStageApp(directory,new WorldFileStore(directory),id=>id===worldId);
  const prefix='/world-assets/'+worldId+'/';
  return {directory,packageDir,app,prefix,image:prefix+'assets/images/'+encodeURIComponent('海 港.webp')};
}
it('serves package bytes, media types, HEAD and conditional cache responses without a JSON envelope',async()=>{
  const {app,image,packageDir,prefix}=await setup();
  const first=await app.request(image);
  expect(first.status).toBe(200);
  expect(first.headers.get('Content-Type')).toBe('image/webp');
  expect(first.headers.get('Cache-Control')).toBe('private, no-cache');
  expect(first.headers.get('Content-Length')).toBe('10');
  expect(first.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(await first.text()).toBe('0123456789');
  const etag=first.headers.get('ETag')!;
  expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
  const head=await app.request(image,{method:'HEAD',headers:{Range:'bytes=0-1'}});
  expect(head.status).toBe(200);expect(head.headers.get('Content-Length')).toBe('10');expect(await head.text()).toBe('');
  const cached=await app.request(image,{headers:{'If-None-Match':'W/'+etag,Range:'bytes=0-1'}});
  expect(cached.status).toBe(304);expect(await cached.text()).toBe('');
  expect((await app.request(image,{headers:{'If-Modified-Since':first.headers.get('Last-Modified')!}})).status).toBe(304);
  // If-None-Match has precedence over a future If-Modified-Since.
  expect((await app.request(image,{headers:{'If-None-Match':'"different"','If-Modified-Since':'Wed, 01 Jan 2100 00:00:00 GMT'}})).status).toBe(200);
  await writeFile(join(packageDir,'assets','images','海 港.webp'),'9876543210');
  const changed=await app.request(image,{headers:{'If-None-Match':etag}});
  expect(changed.status).toBe(200);expect(changed.headers.get('ETag')).not.toBe(etag);expect(await changed.text()).toBe('9876543210');
  const font=await app.request(prefix+'assets/fonts/story.woff2');
  expect(font.headers.get('Content-Type')).toBe('font/woff2');expect(font.headers.get('Access-Control-Allow-Origin')).toBe('*');await font.arrayBuffer();
});
it('supports media byte ranges, strong If-Range, unsatisfiable ranges and full-response multi-range fallback',async()=>{
  const {app,prefix}=await setup(),url=prefix+'assets/audio/sea.wav';
  const first=await app.request(url);const etag=first.headers.get('ETag')!;
  expect(first.headers.get('Content-Type')).toBe('audio/wav');await first.arrayBuffer();
  for(const [header,body,contentRange] of [['bytes=2-5','cdef','bytes 2-5/10'],['bytes=7-','hij','bytes 7-9/10'],['bytes=-3','hij','bytes 7-9/10'],['bytes=0-100','abcdefghij','bytes 0-9/10']]){
    const response=await app.request(url,{headers:{Range:header!,'If-Range':etag}});
    expect(response.status).toBe(206);expect(await response.text()).toBe(body);expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(response.headers.get('Content-Length')).toBe(String(body!.length));expect(response.headers.get('Accept-Ranges')).toBe('bytes');
  }
  for(const range of ['bytes=10-','bytes=8-2','bytes=-0']){
    const response=await app.request(url,{headers:{Range:range}});
    expect(response.status).toBe(416);expect(response.headers.get('Content-Range')).toBe('bytes */10');
  }
  for(const ifRange of ['"old"','W/'+etag]){
    const response=await app.request(url,{headers:{Range:'bytes=0-1','If-Range':ifRange}});
    expect(response.status).toBe(200);expect(await response.text()).toBe('abcdefghij');
  }
  const multi=await app.request(url,{headers:{Range:'bytes=0-1,5-6'}});
  expect(multi.status).toBe(200);expect(await multi.text()).toBe('abcdefghij');
  const empty=await app.request(prefix+'assets/empty.txt',{headers:{Range:'bytes=0-1'}});
  expect(empty.status).toBe(416);expect(empty.headers.get('Content-Range')).toBe('bytes */0');
});
it('returns explicit types for common packaged audio and video formats',async()=>{
  const {app,prefix,packageDir}=await setup();
  for(const [extension,type] of Object.entries({ogg:'audio/ogg',flac:'audio/flac',m4a:'audio/mp4',mov:'video/quicktime'})){
    await writeFile(join(packageDir,'assets','audio','sample.'+extension),'media');
    const response=await app.request(prefix+'assets/audio/sample.'+extension);
    expect(response.headers.get('Content-Type')).toBe(type);await response.arrayBuffer();
  }
});
it('does not expose manifests, components, other worlds, symlinks or paths outside the package',async()=>{
  const {app,prefix,packageDir,directory}=await setup();
  await writeFile(join(directory,'outside.webp'),'secret');
  await symlink(join(directory,'outside.webp'),join(packageDir,'assets','images','link.webp'));
  await symlink(directory,join(packageDir,'assets','linked'));
  for(const path of [
    prefix+'world.json',prefix+'components/Main.tsx',prefix+'assets/images/link.webp',
    prefix+'assets/linked/outside.webp',prefix+'assets/%2e%2e%2fworld.json',
    prefix+'assets/%252e%252e/world.json',prefix+'assets/images/missing.webp',
    '/world-assets/00000000-0000-0000-0000-000000000000/assets/images/x.webp',
  ])expect((await app.request(path)).status,path).toBe(404);
  expect((await app.request(prefix+'assets/empty.txt',{method:'POST'})).status).toBe(404);
  expect((await app.request('/api/v1/worlds')).status).toBe(404);
});
