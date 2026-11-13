export type StateUpdateResult = {
  status: 'disabled' | 'not_required' | 'pending' | 'unchanged' | 'applied' | 'partial' | 'failed' | 'cancelled';
  acceptedCount: number;
  changedPaths: string[];
  skipped: Array<{ index: number; errorCode: string; errorMessage: string }>;
  warningCodes: string[];
  errorCode?: string;
};
export type ActionSuggestionsResult = {
  status: 'disabled' | 'pending' | 'ready' | 'blocked' | 'failed' | 'cancelled';
  items: string[];
  warningCodes: string[];
  errorCode?: string;
  blockedBy?: 'state_partial' | 'state_failed';
};
export type RunExtensions = {
  protocol: 'sr_extensions/v1';
  stateUpdate: StateUpdateResult;
  actionSuggestions: ActionSuggestionsResult;
};
export type CapabilityConfig = {
  state_update: { enabled: boolean; prompt: string };
  action_suggestions: { enabled: boolean; count: number; prompt: string };
};
export type CapabilityOverrides = Partial<Record<keyof CapabilityConfig, boolean>>;
export type PublicCapabilities = {
  stateUpdate: { enabled: boolean; required: boolean };
  actionSuggestions: { enabled: boolean; count: number };
  revision: number;
};
export type RunPhase = 'preparing' | 'narrative' | 'extensions' | 'finalized';

export function initialExtensions(config: CapabilityConfig, active: ReadonlySet<string>): RunExtensions {
  return {
    protocol: 'sr_extensions/v1',
    stateUpdate: { status: !config.state_update.enabled ? 'disabled' : active.size ? 'pending' : 'not_required',
      acceptedCount: 0, changedPaths: [], skipped: [], warningCodes: [] },
    actionSuggestions: { status: config.action_suggestions.enabled ? 'pending' : 'disabled',
      items: [], warningCodes: [] },
  };
}
export function rejectExtensions(result: RunExtensions, cancelled: boolean, errorCode?: string): RunExtensions {
  const next = structuredClone(result);
  if (!['disabled', 'not_required'].includes(next.stateUpdate.status)) {
    next.stateUpdate.status = cancelled ? 'cancelled' : 'failed';
    next.stateUpdate.acceptedCount = 0;
    next.stateUpdate.changedPaths = [];
    next.stateUpdate.errorCode = errorCode;
  }
  if (next.actionSuggestions.status !== 'disabled') {
    next.actionSuggestions.status = cancelled ? 'cancelled' : 'blocked';
    next.actionSuggestions.items = [];
    next.actionSuggestions.blockedBy = 'state_failed';
    next.actionSuggestions.errorCode = errorCode;
  }
  return next;
}
