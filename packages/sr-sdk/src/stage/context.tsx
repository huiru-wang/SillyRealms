import {createContext, useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode} from 'react';
import type {StageSnapshot, StateScope, StateValue} from '../stage-contract.js';
import type {SRWorldStateAPI} from '../world-state.js';
import {StageRuntime, stateValue, type SRSessionAPI, type SRStateAPI} from './runtime.js';
import type {SRComposerButton, StageComposerButtons} from './composer-buttons.js';

const ButtonsContext = createContext<StageComposerButtons | null>(null);
const RuntimeContext = createContext<StageRuntime | null>(null);

/** Internal frame entry: author modules receive only the hooks and command interfaces. */
export function StageProvider({runtime, buttons, children}: {runtime: StageRuntime; buttons: StageComposerButtons; children: ReactNode}) {
  return <RuntimeContext.Provider value={runtime}>
    <ButtonsContext.Provider value={buttons}>{children}</ButtonsContext.Provider>
  </RuntimeContext.Provider>;
}
export function useSRComposerButtons(buttons: readonly SRComposerButton[]): void {
  const registry = useContext(ButtonsContext);
  const owner = useRef(Symbol());
  if (!registry) throw Error('SR stage provider unavailable');
  useLayoutEffect(() => () => registry.release(owner.current), [registry]);
  useLayoutEffect(() => { registry.update(owner.current, buttons); });
}

function useRuntime(): StageRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw Error('SR stage provider unavailable');
  return runtime;
}
export function useSRStageSnapshot(): StageSnapshot {
  const runtime = useRuntime();
  return useSyncExternalStore(runtime.observe, runtime.getSnapshot, runtime.getSnapshot);
}
export function useSRSession(): SRSessionAPI { return useRuntime().session; }
export function useSRStateAPI(): SRStateAPI { return useRuntime().state; }
export function useSRHistory() {
  const runtime = useRuntime();
  const snapshot = useSRStageSnapshot();
  return useMemo(() => ({
    runs: snapshot.runs, ...snapshot.history, ...runtime.history,
  }), [runtime, snapshot.runs, snapshot.history]);
}
export function useSRState<T extends StateValue>(path: string, defaultValue: T, options?: {scope?: StateScope}) {
  const runtime = useRuntime(), snapshot = useSRStageSnapshot(), scope = options?.scope ?? 'message';
  const value = stateValue(snapshot.state, scope, path);
  return [value === undefined ? defaultValue : value as T, (next: T) => runtime.state.updateState(path, next, scope)] as const;
}
export function useSRWorldStateAPI(): SRWorldStateAPI {
  const state = useSRStateAPI();
  return useMemo(() => ({
    getState: (path: string) => state.getState(path, 'global'),
    batchGetState: (entries: Array<{path: string; scope?: 'global'}>) =>
      state.batchGetState(entries.map(entry => ({path: entry.path, scope: 'global' as const})))
        .then(values => values.map(value => ({...value, scope: 'global' as const}))),
  }), [state]);
}
