/** Explicit one-time replacement of retired runtime storage. No old presets or conversations are translated. */
import {DatabaseSync} from 'node:sqlite';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import lockfile from 'proper-lockfile';
import {createSchema} from '../src/infrastructure/database/database.js';
const dir=resolve(process.env.SILLYREALMS_DATA_DIR??fileURLToPath(new URL('../../../db/',import.meta.url)));
if(!process.argv.includes('--confirm-reset-runtime'))throw Error('Pass --confirm-reset-runtime to delete retired preset and session data');
const release=await lockfile.lock(dir,{stale:10000,update:2000,retries:0});
try {
 const db=new DatabaseSync(join(dir,'sillyrealms.sqlite'));
 try {
  const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if(version!==5)throw Error('Expected retired schema v5; database left unchanged');
  const columns=db.prepare('PRAGMA table_info(worlds)').all().map(r=>r.name);
  if(!columns.includes('components')||!columns.includes('stage_component'))throw Error('World storage is not current');
  const backup=join(dir,'before-runtime-v6-'+Date.now()+'.sqlite');
  db.prepare('VACUUM INTO ?').run(backup);
  const counts=Object.fromEntries(['sessions','entries','presets','run_preparations'].map(t=>[t,db.prepare(`SELECT count(*) n FROM ${t}`).get()!.n]));
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
   db.exec(`DELETE FROM tag_assignments WHERE tag_id IN (SELECT id FROM tags WHERE type='preset'); DELETE FROM tags WHERE type='preset';
    UPDATE worlds SET default_preset_id=NULL; UPDATE app_settings SET default_preset_id=NULL;
    DROP TABLE run_preparations; DROP TABLE entries; DROP TABLE sessions; DROP TABLE presets;`);
   // Lore placement belongs exclusively to the preset; discard unused positional metadata.
   for(const row of db.prepare('SELECT id,lorebook_json FROM worlds WHERE lorebook_json IS NOT NULL').all()){
    const lore=JSON.parse(String(row.lorebook_json));
    for(const entry of lore.entries??[])if(entry.load){delete entry.load.anchor;delete entry.load.position;}
    db.prepare('UPDATE worlds SET lorebook_json=? WHERE id=?').run(JSON.stringify(lore),String(row.id));
   }
   createSchema(db);
   db.exec("UPDATE worlds SET default_preset_id='sr-default-preset'; UPDATE app_settings SET default_preset_id='sr-default-preset';");
   if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Reference validation failed');
   db.exec('COMMIT; PRAGMA foreign_keys=ON');
  }catch(e){db.exec('ROLLBACK');throw e;}
  console.log(JSON.stringify({removed:counts,schema:6,backup}));
 }finally{db.close();}
}finally{await release();}
