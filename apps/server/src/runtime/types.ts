import type { Api, Context, Message, Model, ToolChoice } from '@earendil-works/pi-ai';
import type { Json } from '../domain/state/state.js';
import type { ContextComposition, RunAccounting } from './persistence/usage-store.js';
import type { buildContext } from './context/prompt-builder.js';
import type { HistoryItem } from './context/history-compactor.js';
import type { BudgetReport, PreparedRequest } from './context/budget.js';
import type { RunOutcome } from './persistence/run-store.js';
import type { PublicError } from '../common/error-codes.js';
import type { CapabilityConfig, PublicCapabilities, RunExtensions, RunPhase } from './narrative/extension-contract.js';

export type ExecutionMode = 'direct' | 'agent';
export type RuntimeConfig = Readonly<{
  version: 1;
  execution: Readonly<{ mode: ExecutionMode }>;
  model: Readonly<{ configId: string; credentialRef: string; definition: Model<Api> }>;
  generation: Readonly<{ maxOutputTokens: number; temperature?: number }>;
  preset: Readonly<{ id: string; hash: string; nodes: Parameters<typeof buildContext>[1]; summaryPrompt: string }>;
  contextPolicy: ContextPolicy;
  extensions: CapabilityConfig;
  capabilityRevision: number;
  agentPolicy: Readonly<{ allowedTools: readonly string[] }>;
}>;
export type ContextPolicy = Readonly<{
  windowPreset: 'compact' | 'standard' | 'extended';
  measurement: 'current_request' | 'previous_usage';
  safetyMarginTokens: number;
  summary: Readonly<{ inputRatio: number; maxOutputTokens: number }>;
  overflow: Readonly<{ strategy: 'summarize_history'; keepRecentTurns: number; maxPassesPerRequest: number; maxSummaryCallsPerRun: number }>;
}>;
export type SummaryCandidate = { text: string; coveredThroughEntryId: string; gaps?: string[] };
export type ExecutionContext = {
  identity: Readonly<{ sessionId: string; worldId: string; runId: string; requestId: string; expectedTipEntryId: string }>;
  input: Readonly<{ text: string }>;
  source: {
    history: HistoryItem[]; summary?: SummaryCandidate;
    builder: ReturnType<typeof buildContext>; gaps: string[];
  };
  state: {
    baseline: Readonly<Record<string, Json>>;
    baselineHash: string;
    active: Set<string>;
    workspace: Record<string, Json>;
    modules: Record<string, any>;
    definition: unknown;
  };
  request?: PreparedRequest;
  progress: {
    phase: RunPhase; latestEntryId?: string;
    summaryCalls: number; budgetReports: BudgetReport[];
    continuation: Message[]; pendingSummary?: SummaryCandidate; historyView: HistoryItem[]; summaryView?: SummaryCandidate;
  };
  control: { signal: AbortSignal };
  accounting: RunAccounting;
};
export type RunTask = {
  runId: string; requestId: string; controller: AbortController; done: Promise<void>; finish: () => void;
  stopped: boolean; status: 'preparing' | 'running'; drain?: () => void;
  phase?: RunPhase; config?: RuntimeConfig; capabilities?: PublicCapabilities;
};
export type RunEvent = (sessionId: string, event: string, payload: Record<string, unknown>) => void;
export type PreparedRun = {
  config: RuntimeConfig;
  execution: ExecutionContext;
  model: Model<Api>;
  messages: Message[];
  tools: Context['tools'];
  toolChoice?: ToolChoice;
  modules: Record<string, any>;
  worldState: unknown;
  active: Set<string>;
  workspace: Record<string, Json>;
  userInput: string;
  output: number;
  temperature?: number;
  contextComposition: ContextComposition;
  summary?: SummaryCandidate;
  summaryGeneration: Array<{ request: unknown; response: string }>;
  diagnostics: ReturnType<typeof buildContext>['diagnostics'];
};
export type RunnerResult = {
  outcome: RunOutcome;
  failure: PublicError | null;
  partialId: string | null;
  workspace: Record<string, Json>;
  extensions?: RunExtensions;
  diagnostics?: unknown;
};
export type RunnerArgs = {
  sessionId: string; runId: string; userId: string;
  prepared: PreparedRun; task: RunTask; runContext: RunAccounting;
  streamController: ReadableStreamDefaultController<Uint8Array>;
};
