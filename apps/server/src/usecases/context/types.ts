import type { RunWritePermit } from '../../infrastructure/cache/index.js';
import type { ErrorCode } from '../../errors.js';
import type { ModelClient, ModelInfo, ModelMessage, ModelParameters } from '../../infrastructure/model/client.js';
import type { ModelConfig } from '../../modules/models/service.js';
import type { RequestMetrics, SessionService } from '../../modules/sessions/service.js';
import type { ContextSources } from './capture.js';
import type { CompiledNarrativeContext } from './stages/assemble/index.js';
import type { SummaryOutcome } from './stages/compact/index.js';
import type { ContextDiagnostics } from './diagnostics.js';
export type { ContextDiagnostics, ContextMaterialDiagnostic, ContextNodeDiagnostic } from './diagnostics.js';

export type ContextProgress = { type: 'summary_started' } | { type: 'summary_saved'; entryId: string };
export type PrepareContextInput = {
  /** Internal run ownership, used only when saving a generated summary. */
  writePermit?: RunWritePermit;
  sessionId: string;
  signal: AbortSignal;
  onProgress?: (progress: ContextProgress) => void;
};
export type SummaryModelRequest = {
  model: ModelInfo;
  credentialRef: ModelConfig['credentialRef'];
  messages: readonly ModelMessage[];
  maxTokens: number;
  modelParameters: ModelParameters;
  signal: AbortSignal;
  /** Called once credentials are ready, immediately before invoking the model. */
  onStarted: () => void;
};
export type SummaryModelResult = SummaryOutcome;
export type ContextDependencies = Omit<ContextSources, 'sessions'> & {
  sessions: Pick<SessionService, 'require' | 'getHistory' | 'getAssistantCapabilities' | 'appendSummary'>;
  modelClient: Pick<ModelClient, 'resolve' | 'assertMessageOrder'>;
  summarize: (request: SummaryModelRequest) => Promise<SummaryModelResult>;
};
export type ContextModelRequest = Omit<CompiledNarrativeContext, 'diagnostics'> & {
  model: ModelInfo;
  credentialRef: ModelConfig['credentialRef'];
};
export type ContextFailure = {
  code: ErrorCode | 'SUMMARY_FAILED';
  /** Author/preset template source diagnostics for the outer run log; never a state value or SSE payload. */
  detail?: string;
};
export type SummaryReceipt = { entryId: string; metrics: RequestMetrics | null };
type ContextReceipt = { parentEntryId: string | null; summary?: SummaryReceipt };
export type PreparedContext = ContextReceipt & (
  | { ok: true; request: ContextModelRequest; diagnostics: ContextDiagnostics }
  | { ok: false; failure: ContextFailure }
);
