import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../../infrastructure/database/connection.js';
import {createServices} from '../../services.js';
import {worldCardFixture} from './test-fixtures.js';
import {cardToWorld,parseCard} from './parser.js';
import {narrativePreset} from '../../testing/fixtures.js';
let db:DatabaseSync,root:string,services:ReturnType<typeof createServices>;
beforeEach(async()=>{db=openDatabase(':memory:');root=await mkdtemp(join(tmpdir(),'sr-world-management-'));services=createServices(db,root);});
afterEach(async()=>{vi.restoreAllMocks();db.close();await rm(root,{recursive:true,force:true});});
const content=()=>cardToWorld(parseCard(worldCardFixture()));
describe('world management functions',()=>{
 it('queries summaries and literal name/tag filters without decoding large document columns',()=>{
  vi.spyOn(Date,'now').mockReturnValue(100);
  services.worlds.create({...content(),id:'c',name:'港 100%',tags:['港','夜'],extensions:{cover_mosaic_enabled:true,author:{notes:'keep'}}});
  services.worlds.create({...content(),id:'b',name:'港 100%',tags:['港']});
  services.worlds.create({...content(),id:'a',name:'山',tags:['山']});
  db.exec("PRAGMA ignore_check_constraints=ON; UPDATE worlds SET components='unreadable' WHERE id='c'");
  const first=services.worlds.listPage({q:'100%',tag:'港',limit:1});
  expect(first.items[0]).toMatchObject({id:'c',tags:['港','夜'],createdAt:100,coverMosaicEnabled:true});
  expect(first.items[0]).not.toHaveProperty('components');expect(first.items[0]).not.toHaveProperty('extensions');expect(first.hasMore).toBe(true);
  const next=services.worlds.listPage({q:'100%',tag:'港',limit:1,before:{createdAt:100,id:'c'}});
  expect(next.items.map(item=>item.id)).toEqual(['b']);expect(next.items[0]?.coverMosaicEnabled).toBe(false);expect(next.hasMore).toBe(false);
 });
 it('updates only management fields with revision protection and keeps author JSON/state intact',()=>{
  const world=services.worlds.create({...content(),id:'world'});
  const before=db.prepare('SELECT characters_json,openings_json,state FROM worlds WHERE id=?').get(world.id);
  const updated=services.worlds.updateManagement(world.id,{name:'Renamed',tags:[' 夜 ','夜'],expectedRevision:world.revision});
  expect(updated).toMatchObject({name:'Renamed',tags:['夜'],revision:2});
  expect(db.prepare('SELECT characters_json,openings_json,state FROM worlds WHERE id=?').get(world.id)).toEqual(before);
  expect(()=>services.worlds.updateManagement(world.id,{name:'Lost',expectedRevision:1})).toThrow('WORLD_REVISION_CONFLICT');
  expect(services.worlds.require(world.id).name).toBe('Renamed');
  services.worlds.setState(world.id,{coins:99});expect(services.worlds.require(world.id).revision).toBe(2);
  expect(()=>services.worlds.updateManagement(world.id,{expectedRevision:2,characters:[]} as never)).toThrow();
 });
 it('merges the cover flag without replacing author extensions and preserves it through later edits',()=>{
  const extensions={author:{version:'1.0',notes:['keep',false]},custom_key:7};
  const world=services.worlds.create({...content(),extensions});
  expect(world.coverMosaicEnabled).toBe(false);
  const before=db.prepare('SELECT cover,characters_json,openings_json,state FROM worlds WHERE id=?').get(world.id);
  const enabled=services.worlds.updateManagement(world.id,{coverMosaicEnabled:true,expectedRevision:1});
  expect(enabled).toMatchObject({coverMosaicEnabled:true,revision:2,extensions:{...extensions,cover_mosaic_enabled:true}});
  expect(JSON.parse(String(db.prepare('SELECT extensions_json FROM worlds WHERE id=?').get(world.id)?.extensions_json)))
   .toEqual({...extensions,cover_mosaic_enabled:true});
  expect(()=>services.worlds.updateManagement(world.id,{name:'Lost',tags:['lost'],coverMosaicEnabled:false,expectedRevision:1})).toThrow('WORLD_REVISION_CONFLICT');
  expect(services.worlds.require(world.id)).toEqual(enabled);
  const disabled=services.worlds.updateManagement(world.id,{coverMosaicEnabled:false,expectedRevision:2});
  expect(disabled).toMatchObject({coverMosaicEnabled:false,revision:3,extensions:{...extensions,cover_mosaic_enabled:false}});
  const renamed=services.worlds.updateManagement(world.id,{name:'Renamed',expectedRevision:3});
  expect(renamed.extensions).toEqual(disabled.extensions);
  expect(db.prepare('SELECT cover,characters_json,openings_json,state FROM worlds WHERE id=?').get(world.id)).toEqual(before);
 });
 it('keeps absent extensions absent until an explicit cover choice is saved',()=>{
  const world=services.worlds.create(content());
  expect(world).toMatchObject({coverMosaicEnabled:false,extensions:null});
  const updated=services.worlds.updateManagement(world.id,{coverMosaicEnabled:false,expectedRevision:1});
  expect(updated).toMatchObject({coverMosaicEnabled:false,extensions:{cover_mosaic_enabled:false},revision:2});
 });
 it('rejects malformed extension definitions before any content is changed',()=>{
  const world=services.worlds.create({...content(),extensions:{author:'keep'}});
  for(const extensions of [[],true,'text',{cover_mosaic_enabled:1},{cover_mosaic_enabled:'true'}]){
   expect(()=>services.worlds.update(world.id,{name:'Lost',extensions})).toThrow('INVALID_WORLD_CARD');
   expect(services.worlds.require(world.id)).toEqual(world);
   expect(()=>services.worlds.create({...content(),extensions})).toThrow('INVALID_WORLD_CARD');
  }
 });
 it('retains legacy content while clearing defaults and rejects missing references atomically',()=>{
  const preset=services.presets.create(narrativePreset()),world=services.worlds.create({...content(),defaultPresetId:preset.id});
  db.prepare('UPDATE worlds SET description=? WHERE id=?').run('legacy prose',world.id);
  expect(()=>services.worlds.updateManagement(world.id,{name:'lost',tags:['lost'],defaultPresetId:'missing',expectedRevision:1})).toThrow('PRESET_NOT_FOUND');
  expect(services.worlds.require(world.id)).toMatchObject({name:world.name,tags:world.tags,revision:1});
  const updated=services.worlds.updateManagement(world.id,{defaultPresetId:null,expectedRevision:1});
  expect(updated.description).toBe('legacy prose');expect(updated.defaultPresetId).toBeNull();
 });
 it('saves a typed reply-assist default with revision protection and preserves unrelated content',()=>{
  const reply=services.presets.create({...services.presets.getDefault('reply_assist'),name:'World reply'});
  const story=services.presets.create(narrativePreset());
  const world=services.worlds.create({...content(),extensions:{author:'keep'}});
  expect(world.defaultReplyAssistPresetId).toBeNull();
  const before=db.prepare('SELECT characters_json,openings_json,state,extensions_json FROM worlds WHERE id=?').get(world.id);
  for(const [id,code] of [['missing','PRESET_NOT_FOUND'],[story.id,'PRESET_TYPE_MISMATCH']] as const){
   expect(()=>services.worlds.updateManagement(world.id,{name:'Lost',defaultReplyAssistPresetId:id,expectedRevision:1})).toThrow(code);
   expect(services.worlds.require(world.id)).toEqual(world);
  }
  const updated=services.worlds.updateManagement(world.id,{defaultReplyAssistPresetId:reply.id,expectedRevision:1});
  expect(updated).toMatchObject({defaultReplyAssistPresetId:reply.id,revision:2});
  expect(db.prepare('SELECT default_reply_assist_preset_id FROM worlds WHERE id=?').get(world.id)).toMatchObject({default_reply_assist_preset_id:reply.id});
  expect(services.worlds.listUsingDefaultPreset(reply.id,'reply_assist')).toEqual([{id:world.id,name:world.name}]);
  expect(services.worlds.listUsingDefaultPreset(reply.id)).toEqual([]);
  expect(()=>services.worlds.updateManagement(world.id,{defaultReplyAssistPresetId:null,expectedRevision:1})).toThrow('WORLD_REVISION_CONFLICT');
  expect(services.worlds.require(world.id)).toEqual(updated);
  expect(services.worlds.updateManagement(world.id,{defaultReplyAssistPresetId:null,expectedRevision:2})).toMatchObject({defaultReplyAssistPresetId:null,revision:3});
  expect(db.prepare('SELECT characters_json,openings_json,state,extensions_json FROM worlds WHERE id=?').get(world.id)).toEqual(before);
 });
 it('validates new definitions before persistence',()=>{
  expect(()=>services.worlds.create({...content(),characters:[]})).toThrow('INVALID_WORLD_CARD');
  expect(()=>services.worlds.create({...content(),description:'unsupported prose'})).toThrow('INVALID_WORLD_CARD');
  expect(services.worlds.listPage().items).toEqual([]);
 });
 it('returns component-specific file errors without an inline fallback or absolute paths',async()=>{
  const world=services.worlds.create({...content(),components:[{id:'inline',component:'export default ()=>null'},{id:'file',path:'sr-asset://components/file.tsx'},{id:'missing',path:'sr-asset://components/missing.tsx',component:'must not fall back'}]});
  const directory=join(services.worlds.paths(world.id).package,'components');await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'file.tsx'),'export default ()=>"file"');
  const result=await services.worlds.getComponents(world.id);
  expect(result.items.map(item=>item.id)).toEqual(['inline','file']);expect(result.errors.missing).toBeTruthy();
  expect(JSON.stringify(result.errors)).not.toContain(root);
 });
});
