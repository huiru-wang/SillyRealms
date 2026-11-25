import { AppError } from '../errors.js';
import type { ModelStopReason } from '../infrastructure/model/client.js';
import type { collectModel } from '../infrastructure/model/collect.js';
import type { NarrativeStopReason } from '../modules/sessions/service.js';

export function cancellationReason(signal: AbortSignal): NarrativeStopReason {
  return signal.reason === 'server_shutdown' ? 'server_shutdown' : 'cancelled';
}

export function failureReason(error: unknown, attempted: boolean): NarrativeStopReason {
  if (!(error instanceof AppError)) return attempted ? 'provider_error' : 'internal_error';
  switch (error.code) {
    case 'MODEL_NOT_FOUND': return 'model_not_found';
    case 'MODEL_CAPABILITY_UNSUPPORTED': return 'model_capability_unsupported';
    case 'CREDENTIAL_NOT_CONFIGURED': return 'credential_not_configured';
    case 'CREDENTIAL_STORE_ERROR': return 'credential_unavailable';
    case 'PROVIDER_CONTEXT_WINDOW_EXCEEDED': return 'provider_context_window_exceeded';
    case 'PROVIDER_ERROR': return 'provider_error';
    case 'RUN_STOPPED': return 'provider_aborted';
    case 'MODEL_OUTPUT_INCOMPLETE': return 'output_incomplete';
    case 'MODEL_OUTPUT_INVALID': return 'model_output_invalid';
    case 'SUMMARY_CAPACITY_EXCEEDED': return 'summary_capacity_exceeded';
    case 'CONTEXT_BUDGET_EXCEEDED': return 'context_budget_exceeded';
    case 'TIP_CONFLICT': return 'tip_conflict';
    case 'SESSION_NOT_FOUND': return 'session_deleted';
    case 'MESSAGE_PERSIST_FAILED': return 'message_persist_failed';
    case 'INVALID_NARRATIVE_HISTORY':
    case 'INVALID_NARRATIVE_TEMPLATE':
    case 'INVALID_NARRATIVE_STATE':
    case 'INVALID_MODEL_BUDGET':
    case 'INVALID_PARENT_CHAIN':
    case 'MODEL_CONFIG_NOT_FOUND':
    case 'PRESET_NOT_FOUND':
    case 'WORLD_NOT_FOUND': return 'invalid_context';
    default: return 'internal_error';
  }
}

function modelFailureReason(reason: ModelStopReason): NarrativeStopReason {
  switch (reason) {
    case 'aborted': return 'provider_aborted';
    case 'provider_error': return 'provider_error';
    case 'context_window_exceeded': return 'provider_context_window_exceeded';
    case 'invalid_output': return 'model_output_invalid';
    case 'incomplete_output': return 'output_incomplete';
  }
}

export function modelOutcome(result: Awaited<ReturnType<typeof collectModel>>, signal: AbortSignal) {
  let stopReason: NarrativeStopReason | undefined;
  if (signal.aborted) stopReason = cancellationReason(signal);
  else if (result.failed) stopReason = failureReason(result.error, result.attempted);
  else if (result.stopReason) stopReason = modelFailureReason(result.stopReason);
  else if (result.snapshot.tool_calls.length || result.finishReason === 'tool_calls') stopReason = 'tool_execution_unsupported';
  else if (result.finishReason === 'length') stopReason = 'output_limit_reached';
  else if (result.finishReason !== 'stop') stopReason = 'output_incomplete';
  else if (!result.snapshot.content.trim()) stopReason = 'model_output_invalid';
  return stopReason;
}
