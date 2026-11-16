import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
export default defineConfig(({mode})=>{
 const stage=mode==='stage',stagePort=Number(process.env.SR_STUDIO_STAGE_PORT??5175);
 const backend=process.env.SR_STUDIO_SERVER_URL||'http://127.0.0.1:3000';
 const assetBackend=new URL(backend);assetBackend.port=String(process.env.SILLYREALMS_STAGE_PORT??3001);
 if(!Number.isInteger(stagePort)||stagePort<1||stagePort>65535)throw Error('Invalid SR_STUDIO_STAGE_PORT');
 return {
 cacheDir:stage?'node_modules/.vite-stage':'node_modules/.vite',
 plugins:[react(),{name:'creator-origin-boundary',configureServer(server){server.middlewares.use((req,res,next)=>{
  let path:string;try{path=decodeURIComponent(new URL(req.url??'/','http://localhost').pathname);}catch{res.statusCode=400;res.end();return;}
  const modulePath=/^\/(src|node_modules|assets|@fs|@id|@vite)\//.test(path)||path==='/@react-refresh';
  const renderer=path==='/frame.html'||path==='/world-component.html';
  const allowedStagePath=renderer||(modulePath&&!path.endsWith('.html'))||path.startsWith('/world-assets/');
  if(stage?!allowedStagePath:/\/(frame|world-component)\.html$/.test(path)){res.statusCode=404;res.end('Not Found');return;}
  if(!stage&&path==='/api/v1/runtime/web-config'){
   res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
   res.end(JSON.stringify({success:true,errorCode:null,errorMessage:'',data:{stage:{origin:process.env.SILLYREALMS_STAGE_ORIGIN??null,port:stagePort,entryPath:'/frame.html'}}}));return;
  }
  if(/^\/(src|node_modules|assets|@fs|@id|@vite)\//.test(path)||path==='/@react-refresh')res.setHeader('Access-Control-Allow-Origin','*');
  if(!stage)res.setHeader('Content-Security-Policy',"frame-ancestors 'self'");
  if(stage&&renderer)res.setHeader('Content-Security-Policy','sandbox allow-scripts allow-same-origin');
  if(path.includes('message-matcher.worker.ts'))res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'none'");next();
 });}}],
 resolve:{dedupe:['react','react-dom']},
 server:{host:'0.0.0.0',port:stage?stagePort:5174,strictPort:true,proxy:stage?{'/world-assets':assetBackend.origin}:{'/api':backend,'/health':backend}},
 build:{rollupOptions:{input:{main:resolve(__dirname,'index.html'),frame:resolve(__dirname,'frame.html'),worldComponent:resolve(__dirname,'world-component.html')}}},
};});
