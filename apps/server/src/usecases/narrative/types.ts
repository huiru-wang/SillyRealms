import type { RuntimeCache, RunWritePermit } from '../../infrastructure/cache/index.js';
import type { RunLogger, RunLogSink } from '../../infrastructure/logging/run-logger.js';
import type { TransactionRunner } from '../../infrastructure/database/transaction.js';
import type { CredentialService } from '../../modules/credentials/service.js';
import type { ModelService } from '../../modules/models/service.js';
import type { PresetService } from '../../modules/presets/service.js';
import type { SessionService } from '../../modules/sessions/service.js';
import type { StateService } from '../../modules/state/service.js';
import type { WorldService } from '../../modules/worlds/service.js';
import type { EventHub } from '../../infrastructure/events/event-hub.js';
import type { ModelClient } from '../../infrastructure/model/client.js';
import type { SavedUserMessage } from './events.js';
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
};

export type NarrativeDependencies = {
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
};

export type NarrativeExecution = {
  writePermit: RunWritePermit;
  sessionId: string;
  runId: string;
  userEntryId: string;
  assistantEntryId: string;
  userMessage: SavedUserMessage;
  provider: string | null;
  model: string | null;
  prepared: Promise<PreparedContext>;
  getApiKey: (credentialRef: SummaryModelRequest['credentialRef']) => Promise<string>;
  signal: AbortSignal;
  log: RunLogger;
};
