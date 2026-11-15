import {expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {seedSession,seedWorld} from './fixtures/db-seed.js';
import {parseCard} from '../src/domain/world-card.js';
import {WorldRepository} from '../src/repositories/world-repository.js';

it('backs up v3 and removes only worlds.summary, preserving records and repeated startup',()=>{
 const folder=mkdtempSync(join(tmpdir(),'sr-world-summary-')),path=join(folder,'data.sqlite');
 try{
  const old=openDatabase(path);seedWorld(old,'w');seedSession(old,'s','w',null,'p',null,'Keep session','{}',1,2);
  old.exec("ALTER TABLE worlds ADD COLUMN summary TEXT; UPDATE worlds SET summary='legacy summary'; PRAGMA user_version=3;");
  const world=old.prepare('SELECT * FROM worlds').get()!;delete world.summary;
  const tables=['sessions','entries','presets','api_model_configs','app_settings','tags','tag_assignments','run_preparations'];
  const rows=tables.map(table=>old.prepare('SELECT * FROM '+table).all());old.close();
  const migrated=openDatabase(path);
  expect(migrated.prepare('PRAGMA user_version').get()?.user_version).toBe(5);
  expect(migrated.prepare("SELECT 1 FROM pragma_table_info('worlds') WHERE name='summary'").get()).toBeUndefined();
  expect(migrated.prepare('SELECT * FROM worlds').get()).toEqual(world);
  tables.forEach((table,i)=>expect(migrated.prepare('SELECT * FROM '+table).all()).toEqual(rows[i]));
  expect(new WorldRepository(migrated).read('w')?.data).not.toHaveProperty('summary');migrated.close();
  const backupName=readdirSync(folder).find(name=>name.includes('.backup-v3-'));expect(backupName).toBeTruthy();
  const backup=new DatabaseSync(join(folder,backupName!),{readOnly:true});expect(backup.prepare('SELECT summary FROM worlds').get()?.summary).toBe('legacy summary');backup.close();
  openDatabase(path).close();expect(readdirSync(folder).filter(name=>name.includes('.backup-v3-'))).toHaveLength(1);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

it('drops the retired world summary on import without changing prose',()=>{
 const card=parseCard({spec:'world_card',spec_version:'0.1',data:{name:'World',summary:'discard',description:{type:'component',component:'Intro'},components:[{id:'Intro',component:'export default ()=>null'}],characters:[{id:'p',name:'Player',player_selectable:true}],openings:[{id:'o',name:'Opening',content:'keep opening'}]}});
 expect(card.data).not.toHaveProperty('summary');expect(card.data.description).toEqual({type:'component',component:'Intro'});
});
