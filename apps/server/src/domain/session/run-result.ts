import { ErrorCodes, errorInfo, isErrorCode } from '../../common/error-codes.js';

const stateStatuses = ['disabled', 'not_required', 'pending', 'unchanged', 'applied', 'partial', 'failed', 'cancelled'];
const suggestionStatuses = ['disabled', 'pending', 'ready', 'blocked', 'failed', 'cancelled'];
/** Persist only the outcome needed by history and recovery. IDs belong to their columns. */
export function storedRunResult(raw: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { status: raw.status };
  if (isErrorCode(raw.errorCode)) result.errorCode = raw.errorCode;
  const state = raw.extensions?.stateUpdate?.status, suggestions = raw.extensions?.actionSuggestions?.status;
  if (stateStatuses.includes(state) && suggestionStatuses.includes(suggestions)) result.extensions = {
    stateUpdate: { status: state }, actionSuggestions: { status: suggestions },
  };
  return result;
}
/** HTTP/SSE derive phase and error text; live phases come from the active Run. */
export function publicRunResult(raw: Record<string, any>): Record<string, any> {
  const result = storedRunResult(raw);
  const interrupted = raw.status === 'interrupted';
  if (interrupted) result.status = 'failed';
  result.phase = result.status === 'preparing' ? 'preparing' : result.status === 'running' ? 'narrative' : 'finalized';
  if (interrupted) Object.assign(result, errorInfo(ErrorCodes.RUN_INTERRUPTED));
  else if (isErrorCode(result.errorCode)) Object.assign(result, errorInfo(result.errorCode));
  return result;
}
