import { failure } from '../common/http-response.js';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { z } from 'zod';
import { ErrorCodes } from '../common/error-codes.js';

const patchSchema=z.object({
  defaultPresetId:z.string().min(1).nullable().optional(),
  defaultApiModelConfigId:z.string().min(1).nullable().optional(),
}).strict().refine(p=>Object.keys(p).length>0);

export function appSettingsRoutes(db:DatabaseSync):Hono {
  const app=new Hono();
  const read=()=>{
    const row=db.prepare('SELECT * FROM app_settings WHERE id=1').get();
    if(!row) throw new Error('APP_SETTINGS_MISSING');
    return { defaultPresetId:row.default_preset_id as string|null, defaultApiModelConfigId:row.default_api_model_config_id as string|null };
  };
  app.get('/',c=>c.json({item:read()}));
  app.patch('/',async c=>{
    const parsed=patchSchema.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success) return c.json(failure(ErrorCodes.INVALID_REQUEST),422);
    const next={...read(),...parsed.data};
    if(next.defaultPresetId && !db.prepare('SELECT 1 FROM presets WHERE id=?').get(next.defaultPresetId))
      return c.json(failure(ErrorCodes.PRESET_NOT_FOUND),422);
    if(next.defaultApiModelConfigId && !db.prepare('SELECT 1 FROM api_model_configs WHERE id=?').get(next.defaultApiModelConfigId))
      return c.json(failure(ErrorCodes.API_MODEL_CONFIG_NOT_FOUND),422);
    db.prepare('UPDATE app_settings SET default_preset_id=?,default_api_model_config_id=?,updated_at=? WHERE id=1')
      .run(next.defaultPresetId,next.defaultApiModelConfigId,Date.now());
    return c.json({item:read()});
  });
  return app;
}
