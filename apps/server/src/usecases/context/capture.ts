import { DEFAULT_LOCALE, type AppLocale } from '@sillyrealms/sdk/locale';
import type { SettingsReader } from '../../modules/settings/service.js';
import { projectContextMessages, type NarrativeHistoryMessage } from './stages/history/index.js';
import { AppError } from '../../errors.js';
import type { ModelConfig, ModelService } from '../../modules/models/service.js';
import type { Preset, PresetService } from '../../modules/presets/service.js';
import type { Session, SessionEntry, SessionService } from '../../modules/sessions/service.js';
import type { StateService, StateViews } from '../../modules/state/service.js';
import type { CharacterSpriteCatalogItem, World, WorldService } from '../../modules/worlds/service.js';
import { selectNarrativeMaterials, type NarrativeMaterials } from './stages/materials/index.js';
import { buildNarrativeNotes, type ModelNotes } from './stages/model-notes/index.js';
import { resolveContextCapabilities, promptSpriteCatalog } from './capabilities.js';

export type ContextSources = {
  settings: Pick<SettingsReader, 'getOptional'>;
  sessions: Pick<SessionService, 'require' | 'getHistory'>;
  worlds: Pick<WorldService, 'require' | 'getCharacterSpriteCatalog'>;
  presets: Pick<PresetService, 'require'>;
  models: Pick<ModelService, 'require'>;
  state: Pick<StateService, 'getViews' | 'evaluateWhen'>;
};
export type ContextSnapshot = {
  locale: AppLocale;
  session: Session;
  world: World;
  characterSpriteCatalog: readonly CharacterSpriteCatalogItem[];
  preset: Preset;
  modelConfig: ModelConfig;
  history: NarrativeHistoryMessage[];
  historyEntries: SessionEntry[];
  views: StateViews;
  inputText: string;
  inputEntryId: string | null;
  materials: NarrativeMaterials;
  modelNotes: ModelNotes;
};

/** Capture the current session once, independently of the caller's operation. */
export function captureContext(services: ContextSources, sessionId: string): ContextSnapshot {
  const session = services.sessions.require(sessionId);
  const locale = services.settings.getOptional()?.locale ?? DEFAULT_LOCALE;
  const historyEntries = services.sessions.getHistory(sessionId);
  if ((historyEntries.at(-1)?.id ?? null) !== session.tipEntryId) throw new AppError('TIP_CONFLICT');
  const projection = projectContextMessages(historyEntries);
  const world = services.worlds.require(session.worldId);
  const preset = services.presets.require(session.presetId);
  const characterSpriteCatalog = services.worlds.getCharacterSpriteCatalog(session.worldId).items;
  const modelConfig = services.models.require(session.apiModelConfigId);
  const views = services.state.getViews({
    worldId: session.worldId, sessionId: session.id, entryId: session.tipEntryId,
  });
  const captured = structuredClone({ locale, session, world, preset, modelConfig, historyEntries, views, characterSpriteCatalog, ...projection });
  const materials = selectNarrativeMaterials({
    locale: captured.locale, world: captured.world, views: captured.views, history: captured.history,
    playerId: captured.session.userCharacterId, inputText: captured.inputText,
    characterSpriteCatalog: promptSpriteCatalog(captured.preset.config, captured.characterSpriteCatalog),
  }, services.state);
  const capabilities = resolveContextCapabilities(captured.preset.config, materials, captured.characterSpriteCatalog);
  return { ...captured, materials, modelNotes: buildNarrativeNotes(captured.historyEntries, capabilities) };
}
