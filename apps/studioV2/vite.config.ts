import {defineConfig,loadEnv,type Plugin} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
import {allowsEntry} from './entry-policy';

function onlyEntry(preview:boolean):Plugin {
 const filter=(req:{url?:string},res:{statusCode:number;end:(text:string)=>void},next:()=>void)=>{
  const pathname=new URL(req.url??'/', 'http://localhost').pathname;
  if(!allowsEntry(pathname,preview)){res.statusCode=404;res.end('Not found');return;}
  next();
 };
 return {name:'v2-entry-boundary',configureServer(server){server.middlewares.use(filter);},configurePreviewServer(server){server.middlewares.use(filter);}};
}
export default defineConfig(({mode})=>{
 const env=loadEnv(mode,process.cwd(),''),preview=mode==='world-preview';
 const studio=env.VITE_STUDIO_ORIGIN??'http://127.0.0.1:5176';
 const origin=new URL(studio);if(origin.origin!==studio||!['http:','https:'].includes(origin.protocol))throw Error('Invalid VITE_STUDIO_ORIGIN');
 const csp="default-src 'none'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob: "+studio+"; media-src 'self' https: blob: "+studio+"; font-src 'self' data: "+studio+"; connect-src 'none'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
 const security:Plugin={name:'v2-preview-policy',transformIndexHtml(html){return preview?html.replace(/content="default-src[^\"]*"/, 'content="'+csp+'"'):html;}};
 return {
  plugins:[react(),onlyEntry(preview),security],appType:preview?'mpa':'spa',
  resolve:{dedupe:['react','react-dom']},
  server:{host:'127.0.0.1',port:preview?5177:5176,strictPort:true,headers:preview?{'Content-Security-Policy':csp+'; frame-ancestors '+studio}:undefined,
   proxy:preview?undefined:{'/api':env.SR_STUDIO_V2_SERVER_URL??'http://127.0.0.1:3001'}},
  preview:{host:'127.0.0.1',port:preview?5177:5176,strictPort:true,headers:preview?{'Content-Security-Policy':csp+'; frame-ancestors '+studio}:undefined,
   proxy:preview?undefined:{'/api':env.SR_STUDIO_V2_SERVER_URL??'http://127.0.0.1:3001'}},
  build:{outDir:preview?'dist-preview':'dist',rollupOptions:{input:preview?{stage:resolve(process.cwd(),'frame.html'),world:resolve(process.cwd(),'world-component.html')}:resolve(process.cwd(),'index.html')}},
 };
});
