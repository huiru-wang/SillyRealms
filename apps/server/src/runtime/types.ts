import type { PresetBudget } from '../domain/preset-budget.js';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { Json } from '../domain/state/state.js';
import type { ContextComposition, RunAccounting } from './persistence/usage-store.js';
import type { PresetNode } from '../domain/preset/schema.js';
import type { SourceSnapshot,CompiledContext } from './context/contracts.js';
import type { HistoryItem } from './context/compaction/history.js';
import type { PreparedRequest } from './context/budget.js';
import type { RunOutcome } from './persistence/run-store.js';
import type { PublicError } from '../common/error-codes.js';
import type { PostprocessPlan, RunExtensions, RunPhase } from './postprocess/contracts.js';

export type RuntimeConfig = Readonly<{
  model: Readonly<{ configId: string; credentialRef: string; definition: Model<Api> }>;
  generation: Readonly<{ maxOutputTokens: number; temperature?: number }>;
  preset: Readonly<{ id: string; hash: string; nodes: PresetNode[] }>;
  contextPolicy: ContextPolicy;
}>;
export type ContextPolicy = Readonly<{
  budget: PresetBudget;
  safetyMarginTokens: number;
  summary: Readonly<{ prompt:string; inputRatio: number; maxOutputTokens: number }>;
  keepRecentTurns: number;
}>;
export type SummaryCandidate = { text: string; coveredThroughEntryId: string; firstKeptEntryId?: string; sourceFingerprint?: string };
export type ExecutionContext = {
  identity: Readonly<{ sessionId: string; worldId: string; runId: string; requestId: string; expectedTipEntryId: string }>;
  input: Readonly<{ text: string }>;
  source: {
    history: HistoryItem[]; summary?: SummaryCandidate;
    snapshot: SourceSnapshot;
  };
  state: {
    baseline: Readonly<Record<string, Json>>;
    baselineHash: string;
    active: Set<string>;
    modules: Record<string, any>;
    definition: unknown;
  };
  request?: PreparedRequest;
  progress: {
    phase: RunPhase; latestEntryId?: string;
  };
  control: { signal: AbortSignal };
  accounting: RunAccounting;
};
export type RunTask = {
  runId: string; requestId: string; controller: AbortController; done: Promise<void>; finish: () => void;
  stopped: boolean; status: 'preparing' | 'running'; drain?: () => void;
  liveMessage?: { id: string; role: 'assistant'; text: string };
  phase?: RunPhase;
};
export type RunEvent = (sessionId: string, event: string, payload: Record<string, unknown>) => void;
export type PreparedRun = {
  config: RuntimeConfig;
  execution: ExecutionContext;
  model: Model<Api>;
  postprocess: PostprocessPlan;
  compiled: CompiledContext;
  worldState: unknown;
  active: Set<string>;
  contextComposition: ContextComposition;
  summary?: SummaryCandidate;
};
export type RunnerResult = {
  outcome: RunOutcome;
  failure: PublicError | null;
  partialId: string | null;
  workspace: Record<string, Json>;
  extensions?: RunExtensions;
};
export type RunnerArgs = {
  sessionId: string; runId: string; userId: string;
  prepared: PreparedRun; task: RunTask; runContext: RunAccounting;
  streamController: ReadableStreamDefaultController<Uint8Array>;
};
