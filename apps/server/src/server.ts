import {serveStudio} from './infrastructure/http/studio-assets.js';
import {createStageApp,publicOrigin,stageConfig,serveWebConfig} from './infrastructure/http/stage-assets.js';
import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { createApp } from './app.js';
import { WorldFileStore } from './infrastructure/world-files/world-file-store.js';
import { MacKeychainStore } from './infrastructure/credentials/store.js';
import { PiGateway } from './runtime/index.js';
import { openDatabase, recoverInterrupted } from './infrastructure/database/database.js';

const dataDir = process.env.SILLYREALMS_DATA_DIR ?? fileURLToPath(new URL('../../../db/', import.meta.url));
const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const stage=stageConfig();
const devStagePort=Number(process.env.SR_STUDIO_STAGE_PORT??5175);
if(!Number.isInteger(devStagePort)||devStagePort<1||devStagePort>65535)throw Error('Invalid SR_STUDIO_STAGE_PORT');
const hostOrigin=publicOrigin(process.env.SILLYREALMS_HOST_ORIGIN);
if(stage.port===port||(hostOrigin&&stage.origin===hostOrigin))throw Error('Stage must use a different origin and listening port');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const release = await lockfile.lock(dataDir, { stale: 10000, update: 2000, retries: 0, onCompromised: () => { console.error('Data directory lock compromised'); process.exit(1); } });
let db: ReturnType<typeof openDatabase>;
try { db = openDatabase(join(dataDir, 'sillyrealms.sqlite')); recoverInterrupted(db); }
catch (err) { await release(); throw err; }
const worldFiles=new WorldFileStore(dataDir);
try {
  await worldFiles.cleanupOrphans(new Set(db.prepare('SELECT id FROM worlds').all().map(row=>String(row.id))));
} catch { console.warn('SR_WORLD_SOURCE_ORPHAN_CLEANUP_FAILED'); }
const lanAddresses = [...new Set(Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address)))];
const allowedOrigins = new Set(lanAddresses.flatMap(address => [`http://${address}:${port}`, `http://${address}:5174`]).map(value=>new URL(value).origin));
if(hostOrigin)allowedOrigins.add(hostOrigin);
const deniedPorts=[stage.port,...(devStagePort!==port?[devStagePort]:[])];
const deniedOrigins=new Set(['localhost','127.0.0.1','[::1]',...lanAddresses].flatMap(host=>['http:','https:'].flatMap(protocol=>deniedPorts.map(p=>new URL(`${protocol}//${host}:${p}`).origin))));
if(stage.origin)deniedOrigins.add(stage.origin);
const app=createApp(db, new MacKeychainStore(), new PiGateway(), worldFiles, allowedOrigins,deniedOrigins);
const studioDir=fileURLToPath(new URL('../../studio/dist/', import.meta.url));
serveWebConfig(app,stage);
serveStudio(app,studioDir);
const servers:ReturnType<typeof serve>[]=[];
const listen=(fetch:typeof app.fetch,port:number)=>new Promise<void>((resolve,reject)=>{
  const server=serve({fetch,hostname:'0.0.0.0',port},()=>resolve());
  servers.push(server);server.once('error',reject);
});
const closeListeners=()=>Promise.all(servers.map(server=>new Promise<void>((resolve,reject)=>{
  if(!server.listening){resolve();return;}
  server.close(error=>error?reject(error):resolve());
  if('closeIdleConnections' in server)server.closeIdleConnections();
})));
try {
  await listen(createStageApp(studioDir,worldFiles,id=>!!db.prepare('SELECT 1 FROM worlds WHERE id=?').get(id)).fetch,stage.port);
  await listen(app.fetch,port);
  console.log(`SillyRealms 本机访问: http://127.0.0.1:${port}`);
  console.log(`SillyRealms Stage: ${stage.origin??`http://127.0.0.1:${stage.port}`}`);
  for (const address of lanAddresses) console.log(`SillyRealms 局域网访问: http://${address}:${port}`);
  if (!lanAddresses.length) console.log('未发现可用的局域网 IPv4 地址。');
  console.log('局域网访问不需要登录；同网络设备可以操作此实例。');
}catch(error){
  await Promise.all([app.shutdown(),closeListeners()]);db.close();await release();throw error;
}
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  // Finish before tsx watch's 5s SIGKILL deadline. On forced exit proper-lockfile
  // removes our lock synchronously; the next startup recovers unfinished Runs.
  const deadline = setTimeout(() => {
    console.error('SR_SHUTDOWN_TIMEOUT');
    process.exit(1);
  }, 3500);
  void (async () => {
    await Promise.all([app.shutdown(), closeListeners()]);
    db.close();
    await release();
    clearTimeout(deadline);
    process.exit(0);
  })().catch(() => {
    console.error('SR_SHUTDOWN_FAILED');
    process.exit(1);
  });
});
