import type { JsonObject, JsonValue } from '../database/connection.js';

export type WorldContent = {
  spec_version: string;
  name: string;
  description: string | null;
  cover: string | null;
  characters_json: JsonValue[];
  openings_json: JsonValue[];
  lorebook_json: JsonValue | null;
  state_definition_json: JsonValue | null;
  message_render_json: JsonValue | null;
  components: JsonValue[] | null;
  stage_component: string | null;
  extensions_json: JsonValue | null;
  default_preset_id: string | null;
  default_api_model_config_id: string | null;
};

export type CreateWorld = Pick<WorldContent, 'spec_version' | 'name' | 'characters_json' | 'openings_json'>
  & Partial<Omit<WorldContent, 'spec_version' | 'name' | 'characters_json' | 'openings_json'>>
  & { id?: string; state?: JsonObject; tags?: readonly string[] };
export type WorldPatch = Partial<WorldContent> & { tags?: readonly string[] };
export type WorldRecord = WorldContent & {
  id: string;
  state: JsonObject;
  tags: string[];
  created_at: number;
  updated_at: number;
};
export type WorldTag = { name: string; world_count: number };
export type WorldListOptions = { tag?: string; limit?: number; offset?: number };

export const worldContentFields = [
  'spec_version', 'name', 'description', 'cover', 'characters_json', 'openings_json',
  'lorebook_json', 'state_definition_json', 'message_render_json', 'components',
  'stage_component', 'extensions_json', 'default_preset_id', 'default_api_model_config_id',
] as const;
