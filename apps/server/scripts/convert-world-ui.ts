/** Explicit, offline, non-destructive UI format conversion. Never run against a live Server. */
import {DatabaseSync} from 'node:sqlite';
import {resolve,dirname} from 'node:path';
import {existsSync} from 'node:fs';
import lockfile from 'proper-lockfile';
import {convertLegacyUI} from '../../../packages/sr-ui-compiler/src/convert-legacy.js';
import {migrateWorldComponents} from '../src/domain/world-components-migration.js';
import {readWorld} from '../src/repositories/world-repository.js';
const args=process.argv.slice(2),path=args[0];
if(!path||args.some(arg=>arg.startsWith('--')&&arg!=='--apply'))throw Error('Usage: pnpm --filter @sillyrealms/server exec tsx scripts/convert-world-ui.ts DATABASE [--apply]');
const databasePath=resolve(path);if(!existsSync(databasePath))throw Error('Database does not exist');
const release=await lockfile.lock(dirname(databasePath),{retries:0,stale:10000});
let db:DatabaseSync|undefined;
try{
 db=new DatabaseSync(databasePath,{readOnly:!args.includes('--apply')});
 const updates:Array<{id:string;ui:string|null;render:string|null}>=[];
 const legacy=!!db.prepare("SELECT 1 FROM pragma_table_info('worlds') WHERE name='ui_json'").get();
 for(const row of legacy?db.prepare('SELECT * FROM worlds').all():[]){
  const converted=convertLegacyUI(row.ui_json==null?undefined:JSON.parse(String(row.ui_json)),row.message_render_json==null?undefined:JSON.parse(String(row.message_render_json)));
  if(!converted.changed)continue;
  const ui=converted.ui===undefined?null:JSON.stringify(converted.ui),render=converted.messageRender===undefined?null:JSON.stringify(converted.messageRender);
  const view=migrateWorldComponents({description:row.description??undefined,openings:JSON.parse(String(row.openings_json)),ui:converted.ui});
  readWorld({...row,components:JSON.stringify(view.components),stage_component:view.stage_component??null,description:view.description?JSON.stringify(view.description):null,openings_json:JSON.stringify(view.openings),message_render_json:render});
  updates.push({id:String(row.id),ui,render});
 }
 console.log(`Validated ${updates.length} world UI conversions. Original source files, IDs, sessions and state are preserved.`);
 if(args.includes('--apply')&&updates.length){
  const backup=databasePath+'.before-ui-'+Date.now()+'.sqlite';db.prepare('VACUUM INTO ?').run(backup);
  db.exec('BEGIN IMMEDIATE');try{for(const item of updates)db.prepare('UPDATE worlds SET ui_json=?,message_render_json=? WHERE id=?').run(item.ui,item.render,item.id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  console.log('Conversion complete. Backup: '+backup);
 }else console.log('Dry run only. Stop Server and use --apply to convert.');
}finally{db?.close();await release();}
