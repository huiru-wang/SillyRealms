import type { UsageStore, RunContext } from '../persistence/usage-store.js';

/** A single terminal entry point for runtime metrics and future post-run hooks. */
export class RunPostProcessor {
  constructor(private usage: UsageStore, private onSettled: (sessionId: string, runId: string) => void) {}

  process(context: RunContext, outcome: 'completed' | 'failed' | 'stopped'): void {
    if (this.usage.settleRun(context.sessionId, context.runId, outcome, context.durationMs())) {
      this.onSettled(context.sessionId, context.runId);
    }
  }
}
