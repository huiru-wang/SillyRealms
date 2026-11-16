import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import lockfile from 'proper-lockfile';
import {openDatabase,recoverInterrupted} from '../src/infrastructure/database/database.js';
import {seedSession} from './fixtures/db-seed.js';
import {runtimeFixture,textGateway} from './fixtures/runtime-v2.js';
it('explicit reset deletes retired runtime rows and columns while preserving current worlds and model credentials',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sr-runtime-reset-')),path=join(dir,'sillyrealms.sqlite');
 const run=()=>spawnSync(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),'scripts/reset-runtime-data.ts','--confirm-reset-runtime'],{env:{...process.env,SILLYREALMS_DATA_DIR:dir},encoding:'utf8'});
 try{
  const db=openDatabase(path);seedSession(db,'s','w',null,'p',null,'old','{}',1,1);
  const worlds=db.prepare('SELECT * FROM worlds').all(),models=db.prepare('SELECT * FROM api_model_configs').all();
  db.exec('ALTER TABLE sessions ADD COLUMN execution_mode TEXT; ALTER TABLE sessions ADD COLUMN capability_overrides_json TEXT; PRAGMA user_version=5');db.close();
  expect(()=>openDatabase(path)).toThrow('DATABASE_RESET_REQUIRED');
  const release=await lockfile.lock(dir,{retries:0});try{expect(run().status).not.toBe(0);}finally{await release();}
  const result=run();expect(result.status,result.stderr).toBe(0);
  const next=openDatabase(path);
  expect(next.prepare('SELECT * FROM worlds').all()).toEqual(worlds);expect(next.prepare('SELECT * FROM api_model_configs').all()).toEqual(models);
  expect(next.prepare('SELECT count(*) n FROM sessions').get()!.n).toBe(0);expect(next.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(next.prepare('PRAGMA table_info(sessions)').all().map(r=>r.name)).not.toContain('execution_mode');next.close();
  const backup=new DatabaseSync(join(dir,readdirSync(dir).find(n=>n.startsWith('before-runtime-v6-'))!),{readOnly:true});expect(backup.prepare('SELECT count(*) n FROM sessions').get()!.n).toBe(1);backup.close();
  expect(run().status).not.toBe(0); // Never erase target-schema sessions accidentally.
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('recovers interrupted pending postprocessing as failed without fabricating suggestions',()=>{
 const {db}=runtimeFixture(textGateway(''));
 try{
  db.prepare("UPDATE entries SET role='user',ext_data=? WHERE id='opening'").run(JSON.stringify({run:{status:'running',extensions:{stateUpdate:{status:'pending'},actionSuggestions:{status:'pending'}}}}));
  recoverInterrupted(db);const run=JSON.parse(String(db.prepare("SELECT ext_data FROM entries WHERE id='opening'").get()!.ext_data)).run;
  expect(run.status).toBe('interrupted');expect(run.extensions.actionSuggestions.status).toBe('blocked');expect(run.extensions.actionSuggestions).not.toHaveProperty('items');
 }finally{db.close();}
});
