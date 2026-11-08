import type { DatabaseSync } from 'node:sqlite';
import { parseCard } from '../domain/world-card.js';
import { initialState, validateSnapshot } from '../domain/state/state.js';

export type WorldRow = Record<string, any>;
export type WorldCard = ReturnType<typeof parseCard>;

/** The only mapping between the stored World columns and the public World Card contract. */
export function readWorld(row: WorldRow): WorldCard {
  const data: Record<string, unknown> = {
    name: row.name, characters: JSON.parse(String(row.characters_json)),
    openings: JSON.parse(String(row.openings_json)),
  };
  for (const [field, column] of Object.entries({
    summary:'summary', description:'description', cover:'cover',
    lorebook:'lorebook_json', state:'state_definition_json',
    message_render:'message_render_json', ui:'ui_json', extensions:'extensions_json',
  })) {
    if (row[column] == null) continue;
    data[field] = column.endsWith('_json') ? JSON.parse(String(row[column])) : row[column];
  }
  const card = parseCard({ spec:row.spec, spec_version:row.spec_version, data });
  validateSnapshot(card.data.state, 'global', JSON.parse(String(row.state)));
  return card;
}

export class WorldRepository {
  constructor(private db: DatabaseSync) {}
  get(id: string): WorldRow | undefined {
    return this.db.prepare('SELECT * FROM worlds WHERE id=?').get(id) as WorldRow | undefined;
  }
  read(id: string): WorldCard | null {
    const row=this.get(id);
    return row ? readWorld(row) : null;
  }
  insert(input: {
    id: string; card: WorldCard; sourcePath: string | null; sourceHash: string | null;
    sourceKind: 'imported'|'generated'; presetId: string | null; modelId: string | null;
    now: number;
  }): void {
    const { id, card, sourcePath, sourceHash, sourceKind, presetId, modelId, now } = input;
    const data = card.data;
    const json = (v: unknown) => v === undefined ? null : JSON.stringify(v);
    this.db.prepare(`INSERT INTO worlds(
      id,spec,spec_version,name,summary,description,cover,characters_json,openings_json,
      lorebook_json,state_definition_json,message_render_json,ui_json,extensions_json,
      default_preset_id,default_api_model_config_id,state,source_file_path,source_sha256,source_kind,
      created_at,updated_at
    ) VALUES(${new Array(22).fill('?').join(',')})`).run(
      id,card.spec,card.spec_version,data.name,data.summary??null,data.description??null,data.cover??null,
      JSON.stringify(data.characters),JSON.stringify(data.openings),json(data.lorebook),json(data.state),
      json(data.message_render),json(data.ui),json(data.extensions),
      presetId,modelId,JSON.stringify(initialState(data.state,'global')),
      sourcePath,sourceHash,sourceKind,now,now
    );
  }
}
