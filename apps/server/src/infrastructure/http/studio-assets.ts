import type {Hono} from 'hono';
import {serveStatic} from '@hono/node-server/serve-static';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {assetPath} from './stage-assets.js';
export function serveStudio(app:Hono,directory:string){
 if(!existsSync(directory))return;
 app.use('*',async(c,next)=>{
  const path=assetPath(c.req.path);
  if(path==='/frame.html'||path==='/world-component.html')return c.text('Not Found',404);
  await next();
  if(!path.startsWith('/api/')&&c.res.headers.get('content-type')?.includes('text/html')){
   c.header('Content-Security-Policy',"frame-ancestors 'self'");
  }
 });
 app.use('/assets/message-matcher.worker-*',async(c,next)=>{await next();c.header('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'none'");});
 app.use('*',async(c,next)=>{await next();if(!c.req.path.startsWith('/api/'))c.header('Access-Control-Allow-Origin','*');});
 app.use('*',serveStatic({root:directory}));
 app.get('*',async(c,next)=>{if(c.req.path.startsWith('/api/')||c.req.path==='/health')return next();return serveStatic({path:join(directory,'index.html')})(c,next);});
}
