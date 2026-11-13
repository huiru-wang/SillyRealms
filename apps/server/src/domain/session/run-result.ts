import { ErrorCodes, errorInfo, isErrorCode } from '../../common/error-codes.js';

/** One whitelist for HTTP, history and terminal events. Never expose private runtime snapshots. */
export function publicRunResult(raw: Record<string, any>): Record<string, any> {
  const interrupted = raw.status === 'interrupted';
  const status = interrupted ? 'failed' : raw.status;
  const result: Record<string, any> = { runId: raw.runId, status };
  if (raw.executionMode === 'direct' || raw.executionMode === 'agent') result.executionMode = raw.executionMode;
  if (['preparing', 'narrative', 'extensions', 'finalized'].includes(raw.phase))
    result.phase = interrupted ? 'finalized' : raw.phase;
  if (interrupted) Object.assign(result, errorInfo(ErrorCodes.RUN_INTERRUPTED), { phase: 'finalized' });
  else if (isErrorCode(raw.errorCode)) Object.assign(result, errorInfo(raw.errorCode));
  if (raw.failure && ['preparation', 'generation', 'continuation', 'commit'].includes(raw.failure.stage) &&
      ['configuration', 'summary', 'context_window', 'context_integrity', 'provider', 'persistence', 'interrupted'].includes(raw.failure.type))
    result.failure = { stage: raw.failure.stage, type: interrupted ? 'interrupted' : raw.failure.type };
  if (raw.recovery && ['resubmit', 'adjust_configuration', 'inspect'].includes(raw.recovery.action))
    result.recovery = { inputSaved: raw.recovery.inputSaved === true, action: raw.recovery.action };
  if (raw.capabilities) result.capabilities = {
    revision: Number(raw.capabilities.revision ?? 0),
    stateUpdate: { enabled: raw.capabilities.stateUpdate?.enabled === true, required: raw.capabilities.stateUpdate?.required === true },
    actionSuggestions: { enabled: raw.capabilities.actionSuggestions?.enabled === true, count: Number(raw.capabilities.actionSuggestions?.count ?? 3) },
  };
  const ext = raw.extensions;
  if (ext?.protocol === 'sr_extensions/v1') {
    const state = ext.stateUpdate ?? {}, suggestions = ext.actionSuggestions ?? {};
    const stateStatus = interrupted && state.status === 'pending' ? 'failed' : state.status;
    const suggestionStatus = interrupted && suggestions.status === 'pending' ? 'blocked' : suggestions.status;
    result.extensions = {
      protocol: 'sr_extensions/v1',
      stateUpdate: {
        status: stateStatus, acceptedCount: Number(state.acceptedCount ?? 0),
        changedPaths: strings(state.changedPaths), warningCodes: strings(state.warningCodes),
        skipped: Array.isArray(state.skipped) ? state.skipped.slice(0, 100).map((item: Record<string, any>) => ({
          index: Number(item.index), ...errorInfo(isErrorCode(item.errorCode) ? item.errorCode : ErrorCodes.INVALID_STATE_UPDATE),
        })) : [],
        ...(isErrorCode(state.errorCode) ? { errorCode: state.errorCode } : {}),
      },
      actionSuggestions: {
        status: suggestionStatus, items: strings(suggestions.items).slice(0, 4),
        warningCodes: strings(suggestions.warningCodes),
        ...(isErrorCode(suggestions.errorCode) ? { errorCode: suggestions.errorCode } : {}),
        ...(['state_partial', 'state_failed'].includes(suggestions.blockedBy) ? { blockedBy: suggestions.blockedBy } : {}),
      },
    };
  }
  return result;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 100) : [];
}
