import {defineConfig,type ViteDevServer} from 'vite';
import react from '@vitejs/plugin-react';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';

function allowPreviewAssets(server:Pick<ViteDevServer,'middlewares'>){
  server.middlewares.use((request,response,next)=>{
    const path=(request.url??'').split(/[?#]/,1)[0]??'';
    const asset=/^\/(?:src\/|node_modules\/|assets\/|@(?:fs|id|vite)\/|@react-refresh$|preview-frame\.html$)/.test(path);
    // Opaque-origin frames need CORS for modules and styles, never for the API proxy.
    if(asset&&request.headers.origin==='null'&&['GET','HEAD'].includes(request.method??'')){
      response.setHeader('Access-Control-Allow-Origin','null');
      response.setHeader('Vary','Origin');
    }
    next();
  });
}

export default defineConfig({
  plugins:[react(),{
    name:'studio-preview-frame-csp',
    configureServer:allowPreviewAssets,
    configurePreviewServer:allowPreviewAssets,
    transformIndexHtml:{
      order:'post',
      handler(html,context){
        if(!context.path.split(/[?#]/,1)[0]?.endsWith('preview-frame.html'))return html;
        const nonce=randomBytes(18).toString('base64');
        return html.replaceAll('__SR_PREVIEW_NONCE__',nonce).replace(/<script\b/g,'<script nonce="'+nonce+'"');
      },
    },
  }],
  resolve:{dedupe:['react','react-dom']},
  server:{
    port:5174,strictPort:true,
    proxy:{'/api':process.env.SR_STUDIO_SERVER_URL||'http://127.0.0.1:3000','/health':process.env.SR_STUDIO_SERVER_URL||'http://127.0.0.1:3000'},
  },
  build:{rollupOptions:{input:{
    main:resolve(__dirname,'index.html'),
    preview:resolve(__dirname,'preview-frame.html'),
  }}},
});
