import type { UsageStore, RunAccounting } from './usage-store.js';

/** Legacy thin wrapper for idempotent Usage settlement and its notification. */
export class RunPostProcessor {
  constructor(private usage: UsageStore, private onSettled: (sessionId: string, runId: string) => void) {}

  process(context: RunAccounting, outcome: 'completed' | 'failed' | 'stopped', terminal?: Record<string, unknown>): boolean {
    if (this.usage.settleRun(context.sessionId, context.runId, outcome, context.durationMs(), terminal)) {
      this.onSettled(context.sessionId, context.runId);
      return true;
    }
    return false;
  }
}
