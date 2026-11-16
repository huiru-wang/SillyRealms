import { createHash,randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { presetSchema,type PresetConfig } from '../domain/preset/schema.js';
export function decodePreset(row:Record<string,unknown>){
 const value=presetSchema.parse({name:row.name,description:row.description,model_parameters:JSON.parse(String(row.model_parameters)),context_strategy:JSON.parse(String(row.context_strategy)),config_json:JSON.parse(String(row.config_json))});
 const etag='"'+createHash('sha256').update(JSON.stringify([row.id,value,row.updated_at])).digest('hex')+'"';
 return {id:String(row.id),...value,created_at:Number(row.created_at),updated_at:Number(row.updated_at),etag};
}
export function insertPreset(db:DatabaseSync,value:PresetConfig,id:string=randomUUID()){
 const now=Date.now();
 db.prepare('INSERT INTO presets(id,name,description,model_parameters,context_strategy,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,value.name,value.description,JSON.stringify(value.model_parameters),JSON.stringify(value.context_strategy),JSON.stringify(value.config_json),now,now);
 return id;
}
export function updatePreset(db:DatabaseSync,id:string,value:PresetConfig){db.prepare('UPDATE presets SET name=?,description=?,model_parameters=?,context_strategy=?,config_json=?,updated_at=? WHERE id=?').run(value.name,value.description,JSON.stringify(value.model_parameters),JSON.stringify(value.context_strategy),JSON.stringify(value.config_json),Date.now(),id);}
