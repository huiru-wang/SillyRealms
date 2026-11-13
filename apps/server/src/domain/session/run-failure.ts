import { ErrorCodes, type ErrorCode } from '../../common/error-codes.js';
export type FailureStage = 'preparation' | 'generation' | 'continuation' | 'commit';
export function runFailure(code: ErrorCode, stage: FailureStage, inputSaved: boolean, causeCode?: string) {
  let type: 'configuration' | 'summary' | 'context_window' | 'context_integrity' | 'provider' | 'persistence' | 'interrupted' = 'provider';
  let action: 'resubmit' | 'adjust_configuration' | 'inspect' = 'resubmit';
  if (['INVALID_PRESET_BUDGET', 'INVALID_PRESET', 'INVALID_MODEL_PARAMETERS', 'MODEL_NOT_FOUND', 'CREDENTIAL_NOT_CONFIGURED',
    'API_MODEL_CONFIG_NOT_FOUND', 'API_MODEL_CONFIG_NOT_SELECTED', 'PRESET_NOT_FOUND', 'PRESET_NOT_SELECTED', 'INVALID_CAPABILITY_CONFIG',
    'NARRATIVE_SYSTEM_ORDER_UNSUPPORTED', 'CONTEXT_MEASUREMENT_UNSUPPORTED'].includes(code)) { type = 'configuration'; action = 'adjust_configuration'; }
  else if (code.startsWith('SUMMARY_')) {
    type = 'summary';
    if (code === ErrorCodes.SUMMARY_CAPACITY_EXCEEDED || causeCode === ErrorCodes.PROVIDER_CONTEXT_WINDOW_EXCEEDED || causeCode === ErrorCodes.CREDENTIAL_NOT_CONFIGURED) action = 'adjust_configuration';
  } else if (code === ErrorCodes.PROVIDER_CONTEXT_WINDOW_EXCEEDED) { type = 'context_window'; action = 'adjust_configuration'; }
  else if (['INVALID_PARENT_CHAIN', 'INVALID_SUMMARY_BOUNDARY', 'ENTRY_ROLE_MISMATCH', 'TIP_CONFLICT', 'WORLD_CORRUPT', 'PREPARED_REQUEST_CHANGED'].includes(code)) { type = 'context_integrity'; action = 'inspect'; }
  else if (code === ErrorCodes.STATE_COMMIT_FAILED || code === ErrorCodes.INTERNAL_ERROR) { type = 'persistence'; action = 'inspect'; }
  else if (code === ErrorCodes.RUN_INTERRUPTED) type = 'interrupted';
  return { failure: { stage, type }, recovery: { inputSaved, action } };
}
