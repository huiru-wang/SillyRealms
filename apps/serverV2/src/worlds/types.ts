import type { JsonObject, JsonValue } from '../database/connection.js';

export type WorldDescription = string | { type: 'component'; component: string } | null;

export type WorldContent = {
  specVersion: string;
  name: string;
  description: WorldDescription;
  cover: string | null;
  characters: JsonValue[];
  openings: JsonValue[];
  lorebook: JsonValue | null;
  stateDefinition: JsonValue | null;
  messageRender: JsonValue | null;
  components: JsonValue[] | null;
  stageComponent: string | null;
  extensions: JsonValue | null;
  defaultPresetId: string | null;
  defaultApiModelConfigId: string | null;
};

export type CreateWorld = Pick<WorldContent, 'specVersion' | 'name' | 'characters' | 'openings'>
  & Partial<Omit<WorldContent, 'specVersion' | 'name' | 'characters' | 'openings'>>
  & { id?: string; state?: JsonObject; tags?: readonly string[] };
export type WorldPatch = Partial<WorldContent> & { tags?: readonly string[] };
export type World = WorldContent & {
  id: string;
  state: JsonObject;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};
export type WorldTag = { name: string; worldCount: number };
export type WorldListOptions = { tag?: string; limit?: number; offset?: number };
export type WorldPage = { items: World[]; hasMore: boolean };

export const worldContentFields = [
  'specVersion', 'name', 'description', 'cover', 'characters', 'openings',
  'lorebook', 'stateDefinition', 'messageRender', 'components',
  'stageComponent', 'extensions', 'defaultPresetId', 'defaultApiModelConfigId',
] as const;
