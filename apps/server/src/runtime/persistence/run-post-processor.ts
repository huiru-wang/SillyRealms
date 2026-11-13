import type { UsageStore, RunAccounting } from './usage-store.js';

/** Legacy thin wrapper for idempotent Usage settlement and its notification. */
export class RunPostProcessor {
  constructor(private usage: UsageStore, private onSettled: (sessionId: string, runId: string) => void) {}

  process(context: RunAccounting, outcome: 'completed' | 'failed' | 'stopped'): void {
    if (this.usage.settleRun(context.sessionId, context.runId, outcome, context.durationMs())) {
      this.onSettled(context.sessionId, context.runId);
    }
  }
}
