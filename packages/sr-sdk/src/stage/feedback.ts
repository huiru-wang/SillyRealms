import type {StageMessage, StageRun, StageSnapshot} from '../stage-contract.js';

const stopped: Record<string, string> = {
  cancelled: 'notices.cancelled',
  server_shutdown: 'notices.server_shutdown',
  provider_error: 'notices.provider_error',
  provider_aborted: 'notices.provider_aborted',
  provider_context_window_exceeded: 'notices.provider_context_window_exceeded',
  output_limit_reached: 'notices.output_limit_reached',
  output_incomplete: 'notices.output_incomplete',
  model_output_invalid: 'notices.model_output_invalid',
  model_not_found: 'notices.model_not_found',
  model_capability_unsupported: 'notices.model_capability_unsupported',
  credential_not_configured: 'notices.credential_not_configured',
  credential_unavailable: 'notices.credential_unavailable',
  summary_capacity_exceeded: 'notices.summary_capacity_exceeded',
  context_budget_exceeded: 'notices.context_budget_exceeded',
  invalid_context: 'notices.invalid_context',
  tool_execution_unsupported: 'notices.tool_execution_unsupported',
  tip_conflict: 'notices.tip_conflict',
  session_deleted: 'notices.session_deleted',
  message_persist_failed: 'notices.message_persist_failed',
  internal_error: 'notices.internal_error',
};

/** Return translation keys so language changes also update existing messages.
 * Presentation follows Server outcomes. Capability diagnostics never change a completed run. */
export function runNotice(run: StageRun): string | null {
  if (run.status === 'stopping') return 'notices.stopping';
  if (run.status === 'running') return run.phase === 'summarizing' ? 'notices.summarizing'
    : run.phase === 'preparing' ? 'notices.preparing' : 'notices.generating';
  if (run.status === 'stopped') return stopped[run.stopReason ?? ''] ?? 'notices.stopped';
  if (run.status === 'unknown') return 'notices.unknown';
  return null;
}

/** Explain a display-only gap without changing the underlying run outcome. */
export function streamNotice(snapshot: Pick<StageSnapshot, 'streamIncomplete'>): string | null {
  return snapshot.streamIncomplete ? 'notices.streamIncomplete' : null;
}

export function messageNotice(message: StageMessage, status: StageRun['status']): string | null {
  if (message.role !== 'assistant' || message.content.trim()) return null;
  if (message.reasoning_content?.trim()) return message.saved
    ? 'notices.reasoningOnly' : null;
  if (message.tool_calls?.length) return 'notices.toolCalls';
  return status === 'running' || status === 'stopping' ? 'notices.waitingForContent' : 'notices.emptyMessage';
}


/** Preserve the string bridge contract while resolving stable error codes at display time. */
export function stageErrorMessage(message: string, translate: (key: string) => string, exists: (key: string) => boolean): string {
  if (message.includes('；')) {
    const parts = message.split('；').filter(Boolean);
    // Only recognized application errors use the aggregate protocol. Author diagnostics stay literal.
    if (parts.some(item => exists('errors:codes.' + item) || exists(item))) {
      return parts.map(item => stageErrorMessage(item, translate, exists)).join(translate('stage:common.errorSeparator'));
    }
  }
  const code = 'errors:codes.' + message;
  if (exists(code)) return translate(code);
  return exists(message) ? translate(message) : message;
}
