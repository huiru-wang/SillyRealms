import type { StateScope } from '@sillyrealms/sdk/state-validation';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';
import type { CreateWorld, WorldContent } from './types.js';
import { CardError, validateCard, type WorldCard } from './validation.js';

/** Parse a decoded author document through the shared validation rules. */
export function parseCard(raw: unknown): WorldCard {
  return validateCard(raw);
}

/** Decode file bytes here; archive handling does not own JSON parsing. */
export function parseCardBytes(bytes: Uint8Array): WorldCard {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new CardError('$', 'Invalid UTF-8 JSON'); }
  return parseCard(raw);
}

export function initialCardState(card: WorldCard, scope: StateScope): JsonObject {
  return Object.fromEntries(Object.entries(card.data.state?.scopes[scope] ?? {})
    .map(([key, definition]) => [key, structuredClone(definition.initial)]));
}

export function cardToWorld(card: WorldCard): CreateWorld {
  const data = card.data;
  return {
    specVersion: card.spec_version, publication: data.publication ?? null, name: data.name, description: data.description ?? null, cover: data.cover ?? null,
    characters: data.characters as JsonValue[], openings: data.openings as JsonValue[],
    lorebook: (data.lorebook as JsonValue) ?? null, stateDefinition: (data.state as JsonValue) ?? null,
    messageRender: (data.message_render as JsonValue) ?? null, components: (data.components as JsonValue[]) ?? null,
    stageComponent: data.stage_component ?? null, extensions: (data.extensions as JsonValue) ?? null,
    tags: data.tags ?? [], state: initialCardState(card, 'global'),
  };
}

export function worldToCard(world: WorldContent & { tags: readonly string[] }): WorldCard {
  return parseCard({
    spec_version: world.specVersion,
    data: {
      ...(world.publication != null ? { publication: world.publication } : {}),
      name: world.name, characters: world.characters, openings: world.openings, tags: world.tags,
      ...(world.description !== null ? { description: world.description } : {}),
      ...(world.cover !== null ? { cover: world.cover } : {}),
      ...(world.lorebook !== null ? { lorebook: world.lorebook } : {}),
      ...(world.stateDefinition !== null ? { state: world.stateDefinition } : {}),
      ...(world.messageRender !== null ? { message_render: world.messageRender } : {}),
      ...(world.components !== null ? { components: world.components } : {}),
      ...(world.stageComponent !== null ? { stage_component: world.stageComponent } : {}),
      ...(world.extensions !== null ? { extensions: world.extensions } : {}),
    },
  });
}
