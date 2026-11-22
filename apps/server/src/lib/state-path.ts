import { isSafeStateKey, STATE_MAX_DEPTH } from '@sillyrealms/sdk/state-validation';

export function statePathParts(path: string): string[] | null {
  const parts = path.split('.');
  return parts.length <= STATE_MAX_DEPTH && parts.every(isSafeStateKey) ? parts : null;
}
