import {Hono} from 'hono';
import {serveStatic} from '@hono/node-server/serve-static';
import {normalize} from 'node:path/posix';

export interface StageConfig {origin:string|null;port:number;entryPath:'/frame.html'}

export function publicOrigin(value:string|undefined):string|null {
  if(value===undefined)return null;
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Invalid public origin');
  return url.origin;
}

export function stageConfig(env:NodeJS.ProcessEnv=process.env):StageConfig {
  const port=Number(env.SILLYREALMS_STAGE_PORT??3001);
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid SILLYREALMS_STAGE_PORT');
  return {origin:publicOrigin(env.SILLYREALMS_STAGE_ORIGIN),port,entryPath:'/frame.html'};
}

export function assetPath(path:string):string {
  try{return normalize(decodeURIComponent(path));}catch{return '';}
}

export function serveWebConfig(app:Hono,stage:StageConfig){
  app.get('/api/v1/runtime/web-config',c=>{c.header('Cache-Control','no-store');return c.json({stage});});
}

/** Only isolated renderers and built assets live on this origin. No API or SPA fallback. */
export function createStageApp(directory:string):Hono {
  const app=new Hono();
  app.use('*',async(c,next)=>{
    const path=assetPath(c.req.path);
    const renderer=path==='/frame.html'||path==='/world-component.html';
    if(!['GET','HEAD'].includes(c.req.method)||(!renderer&&!path.startsWith('/assets/')))return c.text('Not Found',404);
    await next();
    c.header('X-Content-Type-Options','nosniff');
    if(renderer){
      c.header('Cache-Control','no-cache');
      // Keep the same restrictions even when the renderer is opened outside its Host.
      c.header('Content-Security-Policy','sandbox allow-scripts allow-same-origin');
    }
  });
  app.use('*',serveStatic({root:directory}));
  return app;
}
