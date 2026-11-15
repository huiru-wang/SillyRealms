import {expect,it} from 'vitest';
import {mkdtempSync,readdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/infrastructure/database/database.js';
import {seedWorld,seedSession} from './fixtures/db-seed.js';

it('converts an isolated database only on explicit apply, preserving other data and backing up',()=>{
 const directory=mkdtempSync(join(tmpdir(),'sr-ui-conversion-')),path=join(directory,'data.sqlite'),source=join(directory,'original.json');
 const old=JSON.stringify({type:'react',source:"import {SR} from '@sr/sdk';export default function Main(){return null}"});
 const db=openDatabase(path);seedWorld(db,'world');seedSession(db,'session','world',null,'p',null,'Keep me','{}',1,1);
 db.exec('ALTER TABLE worlds DROP COLUMN components; ALTER TABLE worlds ADD COLUMN ui_json TEXT CHECK(ui_json IS NULL OR json_valid(ui_json)); ALTER TABLE worlds DROP COLUMN stage_component; PRAGMA user_version=4');
 writeFileSync(source,old);db.prepare('UPDATE worlds SET ui_json=?,source_file_path=?,source_sha256=? WHERE id=?').run(old,source,'original-hash','world');
 const before=db.prepare('SELECT * FROM worlds').get()!,session=db.prepare('SELECT * FROM sessions').get();db.close();
 const run=(apply=false)=>execFileSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../scripts/convert-world-ui.ts',import.meta.url)),path,...(apply?['--apply']:[])],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
 const read=(sql:string)=>{const connection=new DatabaseSync(path,{readOnly:true});try{return connection.prepare(sql).get();}finally{connection.close();}};
 try{
  expect(run()).toContain('Dry run only');expect(read('SELECT * FROM worlds')).toEqual(before);
  expect(run(true)).toContain('Conversion complete');const after=read('SELECT * FROM worlds')!;
  expect(JSON.parse(String(after.ui_json))).toMatchObject({main:'Main',source:[{id:'Main'}]});
  expect({...after,ui_json:before.ui_json}).toEqual(before);expect(read('SELECT * FROM sessions')).toEqual(session);
  expect(readFileSync(source,'utf8')).toBe(old);
  const backup=readdirSync(directory).find(name=>name.includes('.before-ui-'));expect(backup).toBeTruthy();
  const original=new DatabaseSync(join(directory,backup!),{readOnly:true});try{expect(original.prepare('SELECT ui_json FROM worlds').get()?.ui_json).toBe(old);}finally{original.close();}
  expect(run(true)).toContain('Validated 0 world UI conversions');
 }finally{rmSync(directory,{recursive:true,force:true});}
},15000);
