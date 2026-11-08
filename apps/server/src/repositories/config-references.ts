import type { DatabaseSync } from 'node:sqlite';

export type ReferenceCounts = { app: number; worlds: number; sessions: number; total: number };
/** All config deletions use the same reference checks, including application defaults. */
export function referenceCounts(db: DatabaseSync, kind:'preset'|'model', id:string): ReferenceCounts {
  const column = kind === 'preset' ? 'default_preset_id' : 'default_api_model_config_id';
  const sessionColumn = kind === 'preset' ? 'preset_id' : 'api_model_config_id';
  const app = Number(db.prepare(`SELECT count(*) AS n FROM app_settings WHERE ${column}=?`).get(id)?.n ?? 0);
  const worlds = Number(db.prepare(`SELECT count(*) AS n FROM worlds WHERE ${column}=?`).get(id)?.n ?? 0);
  const sessions = Number(db.prepare(`SELECT count(*) AS n FROM sessions WHERE ${sessionColumn}=?`).get(id)?.n ?? 0);
  return { app, worlds, sessions, total:app+worlds+sessions };
}
