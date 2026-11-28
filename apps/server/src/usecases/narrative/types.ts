import type { RuntimeCache, RunWritePermit } from '../../infrastructure/cache/index.js';
import type { RunLogger, RunLogSink } from '../../infrastructure/logging/run-logger.js';
import type { TransactionRunner } from '../../infrastructure/database/transaction.js';
import type { CredentialService } from '../../modules/credentials/service.js';
import type { ModelService } from '../../modules/models/service.js';
import type { PresetService } from '../../modules/presets/service.js';
import type { SessionService } from '../../modules/sessions/service.js';
import type { SettingsReader } from '../../modules/settings/service.js';
import type { StateService, StateEvent } from '../../modules/state/service.js';
import type { WorldService } from '../../modules/worlds/service.js';
import type { EventHub } from '../../infrastructure/events/event-hub.js';
import type { ModelClient } from '../../infrastructure/model/client.js';
import type { SavedUserMessage, MessageDeletedEvent } from './events.js';
import type { PreparedContext, SummaryModelRequest } from '../context/index.js';

export type SubmitInput = {
  sessionId: string;
  input: { text: string };
  expectedTipEntryId: string | null;
};

export type AcceptedNarrative = {
  runId: string;
  userEntryId: string;
  /** Reserved at acceptance; terminal events identify whether this entry was actually saved. */
  assistantEntryId: string;
  userMessage: SavedUserMessage;
  tipEntryId: string | null;
  deletedMessageIds: string[];
};

export type NarrativeDependencies = {
  settings: Pick<SettingsReader, 'getOptional'>;
  cache: RuntimeCache;
  sessions: SessionService;
  worlds: WorldService;
  presets: PresetService;
  models: ModelService;
  state: StateService;
  credentials: Pick<CredentialService, 'get'>;
  modelClient: Pick<ModelClient, 'resolve' | 'assertMessageOrder' | 'stream'>;
  events: EventHub;
  transaction: TransactionRunner;
  /** Defaults to one formatted console line per observation; injectable for embedding/tests. */
  logSink?: RunLogSink;
  onStorageFailure?: (error: unknown) => void;
};

export type NarrativeExecution = {
  writePermit: RunWritePermit;
  sessionId: string;
  runId: string;
  userEntryId: string;
  assistantEntryId: string;
  userMessage: SavedUserMessage;
  tipEntryId: string | null;
  deletedMessageIds: string[];
  provider: string | null;
  model: string | null;
  prepared: Promise<PreparedContext>;
  getApiKey: (credentialRef: SummaryModelRequest['credentialRef']) => Promise<string>;
  signal: AbortSignal;
  log: RunLogger;
};

export type RegenerateInput = { sessionId: string; runId: string; expectedAssistantEntryId: string; expectedTipEntryId: string };
export type ReadyNarrative = Pick<AcceptedNarrative, 'userMessage' | 'tipEntryId' | 'deletedMessageIds'> & {
  notifications: Array<MessageDeletedEvent | StateEvent>;
};
export type ActiveNarrative = {
  runId: string; assistantEntryId: string; controller: AbortController; completion: Promise<void>; log: RunLogger;
};
