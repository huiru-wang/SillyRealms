import type { DatabaseSync } from 'node:sqlite';
import { parseCard } from '../../src/domain/world-card.js';
import { WorldRepository } from '../../src/repositories/world-repository.js';

const demoCard = {
  spec:'world_card',spec_version:'0.1',
  data:{name:'Test world',characters:[{id:'p',name:'Player',player_selectable:true}],
    openings:[{id:'o',name:'Opening',content:'Welcome'}]},
};

export function seedModel(db:DatabaseSync, id='test-model', ref='test-ref') {
  db.prepare('INSERT OR IGNORE INTO api_model_configs(id,name,provider_id,model_id,credential_ref,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id,id,'fake','fake',ref,1,1);
}
export function seedWorld(db:DatabaseSync, id:string, card:unknown = demoCard, presetId='sr-default-preset', modelId='test-model') {
  seedModel(db,modelId);
  const normalized=parseCard(card);
  new WorldRepository(db).insert({
    id,card:normalized,sourcePath:null,sourceHash:null,sourceKind:'generated',
    presetId,modelId,now:Date.now(),
  });
}
export function seedSession(
  db:DatabaseSync,id:string,worldId:string,presetId:string|null,characterId:string,
  tipId:string|null,title:string|null,state:string,createdAt:number,updatedAt:number,
  modelId?:string, mode: 'direct'|'agent'='agent',
) {
  if(!db.prepare('SELECT 1 FROM worlds WHERE id=?').get(worldId)) seedWorld(db,worldId);
  const actualPreset=presetId??'sr-default-preset';
  const actualModel=modelId??String(db.prepare('SELECT default_api_model_config_id FROM worlds WHERE id=?').get(worldId)?.default_api_model_config_id??'test-model');
  seedModel(db,actualModel);
  db.prepare('INSERT INTO sessions(id,world_id,preset_id,api_model_config_id,user_character_id,tip_entry_id,title,state,created_at,updated_at,execution_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,worldId,actualPreset,actualModel,characterId,tipId,title,state,createdAt,updatedAt,mode);
}

import type { CredentialStore } from '../../src/infrastructure/credentials/store.js';
export const fakeCredentials: CredentialStore = {
  async get(){ return 'fake-key'; },
  async set(){},
  async delete(){},
};
export function configureWorldModel(db:DatabaseSync, worldId:string, modelId='test-model') {
  seedModel(db,modelId);
  db.prepare('UPDATE worlds SET default_api_model_config_id=? WHERE id=?').run(modelId,worldId);
}
