import type { Presentation } from '@sillyrealms/sdk/presentation';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';

/** Author-declared publication data retains its wire-format keys. */
export type WorldPublication = {
  package_id: string;
  authors: { name: string; url?: string }[];
  creator_notes?: string;
  release: { version: string; published_at: string; notes: string };
  homepage?: string;
  update_url?: string;
};
export type WorldUpdateSource = { worldId: string; packageId: string; updateUrl: string };

export type WorldPresentation = Presentation;

export type WorldContent = {
  specVersion: string;
  publication: WorldPublication;
  name: string;
  presentation: WorldPresentation | null;
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
  defaultReplyAssistPresetId: string | null;
  defaultApiModelConfigId: string | null;
};

export type CreateWorld = Pick<WorldContent, 'specVersion' | 'publication' | 'name' | 'characters' | 'openings'>
  & Partial<Omit<WorldContent, 'specVersion' | 'publication' | 'name' | 'characters' | 'openings'>>
  & { id?: string; state?: JsonObject; tags?: readonly string[] };
export type WorldPatch = Partial<WorldContent> & { tags?: readonly string[] };
export type World = WorldContent & {
  id: string;
  revision: number;
  coverMosaicEnabled: boolean;
  state: JsonObject;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};
export type WorldTag = { name: string; worldCount: number };
export type WorldSummary = Pick<World, 'id' | 'name' | 'publication' | 'cover' | 'coverMosaicEnabled' | 'tags' | 'createdAt' | 'updatedAt'>;
export type WorldDetail = Omit<World, 'state'>;
export type WorldManagementPatch = Partial<Pick<World, 'name' | 'tags' | 'coverMosaicEnabled' | 'defaultPresetId' | 'defaultReplyAssistPresetId' | 'defaultApiModelConfigId'>> & { expectedRevision: number };
export type WorldListOptions = { q?: string; tag?: string; limit?: number; offset?: number; before?: { createdAt: number; id: string } };
export type WorldPage = { items: WorldSummary[]; hasMore: boolean };

export type CharacterSpriteCatalogItem = {
  characterId: string;
  characterName: string;
  spriteId: string;
  description: string;
  asset: string;
};
export type CharacterSpriteCatalog = { worldId: string; items: CharacterSpriteCatalogItem[] };

export const worldContentFields = [
  'specVersion', 'publication', 'name', 'presentation', 'cover', 'characters', 'openings',
  'lorebook', 'stateDefinition', 'messageRender', 'components',
  'stageComponent', 'extensions', 'defaultPresetId', 'defaultReplyAssistPresetId', 'defaultApiModelConfigId',
] as const;
