export type StateUpdateDiagnostic = {
  index?: number;
  path?: string;
  scope: 'message';
  errorCode: string;
  statePath?: string;
  rulePath?: string;
};

export type StateUpdateResult = {
  status: 'disabled' | 'not_required' | 'pending' | 'unchanged' | 'applied' | 'partial' | 'failed' | 'cancelled';
  errorCode?: string;
  /** Ephemeral diagnostics: persistableExtensions deliberately retains only status. */
  diagnostics?: StateUpdateDiagnostic[];
};
export type ActionSuggestionsResult = {
  status: 'disabled' | 'pending' | 'ready' | 'blocked' | 'failed' | 'cancelled';
  items: string[];
};
export type RunExtensions = {
  stateUpdate: StateUpdateResult;
  actionSuggestions: ActionSuggestionsResult;
};
export type PostprocessPlan = Readonly<{
 presetHash:string;
 state_update:Readonly<{enabled:boolean;required:boolean;roots:readonly string[]}>;
 action_suggestions:Readonly<{enabled:boolean}>;
}>;
export type PersistentRunExtensions = {
 stateUpdate: Pick<StateUpdateResult,'status'>;
 actionSuggestions: Pick<ActionSuggestionsResult,'status'>;
};
export function persistableExtensions(result:RunExtensions):PersistentRunExtensions {
 return {stateUpdate:{status:result.stateUpdate.status},actionSuggestions:{status:result.actionSuggestions.status}};
}
export type RunPhase = 'preparing' | 'narrative' | 'extensions' | 'finalized';

export function initialExtensions(config: PostprocessPlan): RunExtensions {
  return {
    stateUpdate: { status: !config.state_update.enabled ? 'disabled' : config.state_update.required ? 'pending' : 'not_required' },
    actionSuggestions: { status: config.action_suggestions.enabled ? 'pending' : 'disabled',
      items: [] },
  };
}
export function rejectExtensions(result: RunExtensions, cancelled: boolean, errorCode?: string): RunExtensions {
  const next = structuredClone(result);
  if (!['disabled', 'not_required'].includes(next.stateUpdate.status)) {
    next.stateUpdate.status = cancelled ? 'cancelled' : 'failed';
    next.stateUpdate.errorCode = errorCode;
  }
  if (next.actionSuggestions.status !== 'disabled') {
    next.actionSuggestions.status = cancelled ? 'cancelled' : 'blocked';
    next.actionSuggestions.items = [];
  }
  return next;
}
