import type { Api, Context, Message, Model } from '@earendil-works/pi-ai';
import type { Json } from '../../domain/state/state.js';
import type { ContextComposition } from '../persistence/usage-store.js';
import type { buildContext } from '../context/prompt-builder.js';

export type RunTask = {
  runId: string;
  requestId: string;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  stopped: boolean;
  status: 'preparing' | 'running';
  drain?: () => void;
};

export type RunEvent = (sessionId: string, event: string, payload: Record<string, unknown>) => void;

export type PreparedRun = {
  model: Model<Api>;
  key: string;
  messages: Message[];
  tools: Context['tools'];
  modules: Record<string, any>;
  worldState: unknown;
  active: Set<string>;
  workspace: Record<string, Json>;
  userInput: string;
  output: number;
  temperature?: number;
  contextComposition: ContextComposition;
  summary?: { text: string; coveredThroughEntryId: string };
  summaryGeneration: Array<{ request: unknown; response: string }>;
  diagnostics: ReturnType<typeof buildContext>['diagnostics'];
};
