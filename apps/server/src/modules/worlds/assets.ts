import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { decodeHTMLAttribute, decodeHTMLStrict } from 'entities';
import { parseSRAssetUri } from '@sillyrealms/sdk/assets';
import { CardError, validateComponents, type WorldCard } from './validation.js';
import type { PackageFile } from './files.js';

type Components = NonNullable<WorldCard['data']['components']>;
type FileResolver = (path: string) => Promise<PackageFile>;
export const COMPONENT_LIMIT = 1024 * 1024;
const COMPONENT_TOTAL = 2 * 1024 * 1024;
type ResourceReference = { uri: string; location: string; literal?: boolean };

export function readableReason(error:unknown):string {
  if(error instanceof CardError)return error.reason;
  const code=(error as NodeJS.ErrnoException)?.code;
  if(code==='ENOENT')return '文件不存在';
  if(code==='EACCES'||code==='EPERM')return '文件无法读取';
  if (code) return '文件读取失败';
  return error instanceof Error ? error.message : '文件读取失败';
}

/** Inspect declared display resources; never scan arbitrary component source or prompts. */
function resourceReferences(card:WorldCard):ResourceReference[] {
  const references:ResourceReference[]=[];
  const add=(value:string|undefined,location:string,literal?:boolean)=>{
    if(value && /^sr-asset:/i.test(value.trim()))references.push({uri:value,location,literal});
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
  const presentation=(value:WorldCard['data']['presentation'],location:string)=>{
    if(value?.type==='markdown')prose(value.text,location+'.text');
  };
  presentation(card.data.presentation,'$.data.presentation');
  card.data.characters.forEach((item,index)=>{
    add(item.avatar,'$.data.characters['+index+'].avatar');
    item.sprites?.forEach((sprite, spriteIndex) => add(sprite.asset, '$.data.characters[' + index + '].sprites[' + spriteIndex + '].asset', true));
    presentation(item.presentation,'$.data.characters['+index+'].presentation');
  });
  card.data.openings.forEach((item,index)=>{
    prose(item.content,'$.data.openings['+index+'].content');
    presentation(item.presentation,'$.data.openings['+index+'].presentation');
  });
  card.data.lorebook?.entries.forEach((item,index)=>prose(item.content,'$.data.lorebook.entries['+index+'].content'));
  card.data.message_render?.rules?.forEach((item,index)=>{
    if(item.replacement.type!=='component')prose(item.replacement.text,'$.data.message_render.rules['+index+'].replacement.text');
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
    if(!stat.isFile()||stat.dev!==file.stat.dev||stat.ino!==file.stat.ino||stat.size>COMPONENT_LIMIT)throw new Error('组件源码超过 1 MiB 或不是常规文件');
    const bytes=Buffer.alloc(COMPONENT_LIMIT+1);
    let size=0;
    while(size<bytes.length){const result=await handle.read(bytes,size,bytes.length-size,size);if(!result.bytesRead)break;size+=result.bytesRead;}
    if(size>COMPONENT_LIMIT)throw new Error('组件源码超过 1 MiB');
    const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));
    if(!source.trim())throw new Error('组件源码为空');
    return source;
  }finally{await handle.close();}
}

export async function validateAssets(card:WorldCard, resolve:FileResolver|null):Promise<void> {
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
    if(!item.literal && /\$(?:\d+|<[^>]+>)/.test(path))continue;
    try {await resolve(path);}
    catch(error){throw new CardError(item.location,path+'：'+readableReason(error));}
  }
}


/** Resolve each declared component independently; a path never falls back to inline source. */
export async function readComponents(value: unknown, resolve: FileResolver) {
  const declarations = validateComponents(value);
  const items: { id: string; component: string }[] = [], errors: Record<string,string> = Object.create(null);
  let total = 0;
  for (const declaration of declarations) {
    try {
      const source = await readComponent(declaration, resolve);
      total += Buffer.byteLength(source, 'utf8');
      if (total > COMPONENT_TOTAL) throw new Error('组件源码总量超过 2 MiB');
      items.push({ id: declaration.id, component: source });
    } catch (error) { errors[declaration.id] = readableReason(error); }
  }
  return { items, errors };
}
