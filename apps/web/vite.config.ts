import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({plugins:[react(),{name:'message-worker-csp',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url?.includes('message-matcher.worker.ts'))res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'none'");next();});}}],server:{port:5173,headers:{'Access-Control-Allow-Origin':'*'},proxy:{'/api':'http://127.0.0.1:3000','/health':'http://127.0.0.1:3000'}},build:{rollupOptions:{input:{main:resolve(__dirname,'index.html'),frame:resolve(__dirname,'frame.html')}}}});
