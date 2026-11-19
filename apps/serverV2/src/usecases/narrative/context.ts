import { AppError } from '../../errors.js';
import type { ModelConfig, ModelService } from '../../modules/models/service.js';
import type { Preset, PresetService } from '../../modules/presets/service.js';
import type { Session, SessionEntry, SessionService } from '../../modules/sessions/service.js';
import type { StateService, StateViews } from '../../modules/state/service.js';
import type { World, WorldService } from '../../modules/worlds/service.js';
import { selectNarrativeMaterials, type NarrativeHistoryMessage, type NarrativeMaterials } from './materials.js';

export type NarrativeContextServices = {
  sessions: Pick<SessionService, 'require' | 'getHistory'>;
  worlds: Pick<WorldService, 'require'>;
  presets: Pick<PresetService, 'require'>;
  models: Pick<ModelService, 'require'>;
  state: Pick<StateService, 'getViews' | 'evaluateWhen'>;
};
export type CaptureNarrativeInput = {
  sessionId: string;
  inputText: string;
  userEntryId: string;
  previousTipEntryId: string | null;
};
export type NarrativeSnapshot = {
  session: Session;
  world: World;
  preset: Preset;
  modelConfig: ModelConfig;
  history: NarrativeHistoryMessage[];
  views: StateViews;
  inputText: string;
  materials: NarrativeMaterials;
};

function narrativeMessage(entry: SessionEntry): NarrativeHistoryMessage | null {
  if (entry.type === 'compaction') throw new AppError('NARRATIVE_HISTORY_UNSUPPORTED');
  const message = entry.payload.message;
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.role !== entry.role ||
    typeof message.content !== 'string' || typeof message.timestamp !== 'number' ||
    !Number.isFinite(message.timestamp) || message.timestamp < 0) throw new AppError('INVALID_NARRATIVE_HISTORY');
  // Reasoning/tool-only assistant entries remain durable, but are not empty model turns.
  // Their non-visible fields never become prompt text or material activation keywords.
  if (entry.role === 'assistant' && !message.content.trim()) return null;
  return { id: entry.id, role: entry.role, text: message.content, timestamp: message.timestamp };
}

/** Called synchronously after persisting the user, before credential/model awaits. */
export function captureNarrativeContext(services: NarrativeContextServices, input: CaptureNarrativeInput): NarrativeSnapshot {
  const session = services.sessions.require(input.sessionId);
  const chain = services.sessions.getHistory(input.sessionId), accepted = chain.at(-1);
  if (session.tipEntryId !== input.userEntryId || accepted?.id !== input.userEntryId ||
    accepted.parentId !== input.previousTipEntryId) throw new AppError('TIP_CONFLICT');
  const user = narrativeMessage(accepted);
  if (!user || user.role !== 'user' || user.text !== input.inputText) throw new AppError('INVALID_NARRATIVE_HISTORY');
  const history = chain.slice(0, -1).map(narrativeMessage).filter((message): message is NarrativeHistoryMessage => message !== null);
  const world = services.worlds.require(session.worldId);
  const preset = services.presets.require(session.presetId);
  const modelConfig = services.models.require(session.apiModelConfigId);
  const views = services.state.getViews({
    worldId: session.worldId, sessionId: session.id, entryId: input.previousTipEntryId,
  });
  const captured = structuredClone({ session, world, preset, modelConfig, history, views, inputText: input.inputText });
  const materials = selectNarrativeMaterials({
    world: captured.world, views: captured.views, history: captured.history,
    playerId: captured.session.userCharacterId, inputText: captured.inputText,
  }, services.state);
  return { ...captured, materials };
}
