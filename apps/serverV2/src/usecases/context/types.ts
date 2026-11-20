import type { RunWritePermit } from '../../infrastructure/cache/index.js';
import type { ErrorCode } from '../../errors.js';
import type { ModelClient, ModelInfo, ModelMessage } from '../../infrastructure/model/client.js';
import type { ModelConfig } from '../../modules/models/service.js';
import type { EntryMetrics, SessionService } from '../../modules/sessions/service.js';
import type { NarrativeContextServices } from './capture.js';
import type { CompiledNarrativeContext } from './stages/assemble/index.js';
import type { SummaryOutcome } from './stages/compact/index.js';
import type { ContextDiagnostics } from './diagnostics.js';
export type { ContextDiagnostics, ContextMaterialDiagnostic, ContextNodeDiagnostic } from './diagnostics.js';

export type ContextProgress = { type: 'summary_started' } | { type: 'summary_saved'; entryId: string };
export type PrepareContextInput = {
  /** Internal run ownership, used only when saving a generated summary. */
  writePermit?: RunWritePermit;
  kind: 'narrative';
  sessionId: string;
  runId: string;
  userEntryId: string;
  previousTipEntryId: string | null;
  inputText: string;
  signal: AbortSignal;
  onProgress?: (progress: ContextProgress) => void;
};
export type SummaryModelRequest = {
  model: ModelInfo;
  credentialRef: ModelConfig['credentialRef'];
  messages: readonly ModelMessage[];
  maxTokens: number;
  temperature?: number;
  thinkingEnabled: boolean;
  signal: AbortSignal;
  /** Called once credentials are ready, immediately before invoking the model. */
  onStarted: () => void;
};
export type SummaryModelResult = SummaryOutcome;
export type ContextDependencies = Omit<NarrativeContextServices, 'sessions'> & {
  sessions: Pick<SessionService, 'require' | 'getHistory' | 'appendEntry'>;
  modelClient: Pick<ModelClient, 'resolve' | 'assertMessageOrder'>;
  summarize: (request: SummaryModelRequest) => Promise<SummaryModelResult>;
};
export type ContextModelRequest = Omit<CompiledNarrativeContext, 'diagnostics'> & {
  model: ModelInfo;
  credentialRef: ModelConfig['credentialRef'];
};
export type ContextFailure = { code: ErrorCode | 'SUMMARY_FAILED' };
export type SummaryReceipt = { entryId: string; metrics: EntryMetrics | null };
type ContextReceipt = { parentEntryId: string; summary?: SummaryReceipt };
export type PreparedContext = ContextReceipt & (
  | { ok: true; request: ContextModelRequest; diagnostics: ContextDiagnostics }
  | { ok: false; failure: ContextFailure }
);
