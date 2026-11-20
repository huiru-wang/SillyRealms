import {useLayoutEffect, useRef, type KeyboardEvent} from 'react';
import {useStoryConfiguration} from '../story-context.js';
import type {StateScope} from '../stage-contract.js';
import {useSRStageSnapshot} from './context.js';
import {stateValue} from './runtime.js';

/** A view of the Host-provided snapshot. Opening this panel performs no additional state read. */
export function StatePanel({close, restoreFocus, overlay, id}: {
  close(): void; restoreFocus(): void; overlay: boolean; id: string;
}) {
  const config = useStoryConfiguration(), snapshot = useSRStageSnapshot();
  const dialog = useRef<HTMLDialogElement>(null), aside = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const definitions = config.state as {scopes?: Partial<Record<StateScope, Record<string, unknown>>>};
  const scopes: StateScope[] = ['global', 'session', 'message'];
  const entries = scopes.flatMap(scope => Object.keys(definitions.scopes?.[scope] ?? snapshot.state[scope])
    .map(path => ({scope, path, value: stateValue(snapshot.state, scope, path)})));
  useLayoutEffect(() => {
    const element = overlay ? dialog.current : aside.current;
    if (!element) return;
    if (overlay) { dialog.current!.showModal(); closeButton.current?.focus({preventScroll: true}); }
    return () => {
      const hadFocus = element.contains(document.activeElement);
      if (element instanceof HTMLDialogElement && element.open) element.close();
      if (hadFocus) restoreFocus();
    };
  }, [overlay, restoreFocus]);
  function wrapModalFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const element = event.currentTarget;
    const controls = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled),summary,[tabindex]:not([tabindex="-1"])'))
      .filter(control => control.tabIndex >= 0 && control.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) return;
    const active = element.ownerDocument.activeElement;
    if (event.shiftKey && (active === first || active === element)) { event.preventDefault(); last.focus({preventScroll: true}); }
    else if (!event.shiftKey && (active === last || active === element)) { event.preventDefault(); first.focus({preventScroll: true}); }
  }
  const labels: Record<StateScope, string> = {global: '世界状态', session: '会话状态', message: '当前剧情'};
  const content = <>
    <header className="sr-state-heading"><h2 id={id + '-title'}>会话状态</h2><button ref={closeButton} type="button" onClick={close} aria-label="收起状态">收起</button></header>
    <div className="sr-state-content">
      {snapshot.stateError && <p className="sr-state-error" role="alert">{snapshot.stateError}</p>}
      {snapshot.stateLoading && !entries.length ? <p className="sr-state-empty" role="status">正在加载状态…</p>
        : entries.length ? scopes.map(scope => {
          const items = entries.filter(item => item.scope === scope);
          return items.length ? <details className="sr-state-group" key={scope} open><summary>{labels[scope]}</summary><dl>{items.map(item =>
            <div className="sr-state-value" key={item.path}><dt>{item.path}</dt><dd><code>{item.value === undefined ? '—' : typeof item.value === 'string' ? item.value : JSON.stringify(item.value, null, 2)}</code></dd></div>
          )}</dl></details> : null;
        }) : !snapshot.stateError && <p className="sr-state-empty">暂无状态</p>}
    </div>
  </>;
  return overlay
    ? <dialog ref={dialog} id={id} className="sr-story-state sr-story-dialog" aria-labelledby={id + '-title'} onKeyDown={wrapModalFocus}
      onCancel={event => { event.preventDefault(); close(); }} onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
      }}>{content}</dialog>
    : <aside ref={aside} id={id} className="sr-story-state" aria-labelledby={id + '-title'}>{content}</aside>;
}
