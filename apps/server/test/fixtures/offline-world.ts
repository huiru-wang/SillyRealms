import {ZipFile} from 'yazl';
import type {Hono} from 'hono';

/** A portable archive exercises the real importer; never touches the user's data directory. */
export async function seedOfflineWorld(app:Hono):Promise<{worldId:string;sessionId:string}> {
  const image='sr-asset://assets/images/港口 夜景.svg';
  const data={
    name:'离线雾港',cover:image,
    characters:[{id:'player',name:'爱丽丝',player_selectable:true,avatar:image,description:'![角色离线图片](<'+image+'>)'}],
    description:{type:'component',component:'Preview'},
    openings:[
      {id:'opening',name:'抵达雾港',content:'![开局离线图片](<'+image+'>)\n\n暮色笼罩了港口。',type:'component',component:'Preview'},
      {id:'plain',name:'静态开局',content:'![静态离线图片](<'+image+'>)'},
    ],
    lorebook:{entries:[{id:'harbor',title:'雾港地图',content:'![世界书离线图片](<'+image+'>)'}]},
    stage_component:'Main',
    components:[
      {id:'Main',path:'sr-asset://components/stage/Main.tsx',component:'export default function Fallback(){return <p data-inline-fallback>不应使用内联源码</p>}'},
      {id:'WeatherLabel',path:'sr-asset://components/shared/WeatherLabel.tsx'},
      {id:'Preview',path:'sr-asset://components/preview/Preview.tsx'},
      {id:'CGImage',path:'sr-asset://components/shared/CGImage.tsx'},
    ],
    message_render:{rules:[{id:'cg',roles:['assistant'],pattern:'<(Badge)\\s*/>',replacement:{type:'component',component:'CGImage'}}]},
  };
  const zip=new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({spec:'world_card',spec_version:'0.1',data})),'world.json');
  const sources:Record<string,string>={
    'components/stage/Main.tsx':"import {SR,useSRAssetUrl} from '@sillyrealms/sdk';import WeatherLabel from './WeatherLabel';export default function Main(){const src=useSRAssetUrl("+JSON.stringify(image)+");return <section data-offline-stage><img data-offline-stage-image src={src} width={160}/><WeatherLabel/><SR.WorldStory/></section>}",
    'components/shared/WeatherLabel.tsx':"export default function WeatherLabel(){return <small data-offline-weather>包内组件：薄雾</small>}",
    'components/preview/Preview.tsx':"import {useSRAssetUrl} from '@sillyrealms/sdk';export default function Preview(){const image=useSRAssetUrl("+JSON.stringify(image)+");const audio=useSRAssetUrl('sr-asset://assets/audio/sea.wav');return <section><h2>雾港离线资源</h2><img data-offline-preview src={image} width={320}/><audio data-offline-audio controls preload='metadata' src={audio}/></section>}",
    'components/shared/CGImage.tsx':"import {useSRAssetUrl} from '@sillyrealms/sdk';export default function CGImage({groups}){const key=groups?.[0]??'';const src=useSRAssetUrl(/^[a-zA-Z0-9_-]+$/.test(key)?'sr-asset://assets/images/cg/'+key+'.svg':null);return src?<img data-offline-cg src={src} width={160} alt='剧情插图'/>:null}",
  };
  for(const [path,source] of Object.entries(sources))zip.addBuffer(Buffer.from(source),path);
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#152b3e"/><path d="M0 130L80 70L140 100L230 42L320 94V180H0Z" fill="#527c87"/><circle cx="250" cy="36" r="15" fill="#e5c78a"/></svg>';
  zip.addBuffer(Buffer.from(svg),'assets/images/港口 夜景.svg');
  zip.addBuffer(Buffer.from(svg),'assets/images/cg/Badge.svg');
  const audio=Buffer.alloc(44+8000);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(8000,24);audio.writeUInt32LE(8000,28);audio.writeUInt16LE(1,32);audio.writeUInt16LE(8,34);audio.write('data',36);audio.writeUInt32LE(8000,40);audio.fill(128,44);
  zip.addBuffer(audio,'assets/audio/sea.wav');
  const archive=await new Promise<Buffer>((resolve,reject)=>{const chunks:Buffer[]=[];zip.outputStream.on('data',chunk=>chunks.push(chunk));zip.outputStream.once('error',reject);zip.outputStream.once('end',()=>resolve(Buffer.concat(chunks)));zip.end();});
  const form=new FormData();form.set('file',new File([new Uint8Array(archive)],'离线雾港.zip'));
  const imported=await app.request('/api/v1/worlds/import',{method:'POST',body:form});
  const body=await imported.json() as {success:boolean;data:{item:{id:string}}};
  if(!body.success)throw Error('Offline ZIP fixture import: '+JSON.stringify(body));
  const worldId=body.data.item.id;
  const response=await app.request('/api/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({worldId,openingId:'opening',userCharacterId:'player'})});
  const session=await response.json() as {success:boolean;data:{item:{id:string}}};
  if(!session.success)throw Error('Offline ZIP fixture session: '+JSON.stringify(session));
  return {worldId,sessionId:session.data.item.id};
}
