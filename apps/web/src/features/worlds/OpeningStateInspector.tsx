import React, {useEffect, useRef} from 'react';

import {openingStateRows, type Row} from './opening-state';

export function OpeningStateInspector({state, override, onClose}: {state: unknown; override: unknown; onClose: () => void}) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {event.preventDefault(); onClose(); return;}
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last.focus();}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
    };
    document.addEventListener('keydown', keydown);
    return () => {document.removeEventListener('keydown', keydown); previous?.focus();};
  }, [onClose]);
  let rows: Row[] = [], error = '';
  try {rows = openingStateRows(state, override);} catch (e) {error = e instanceof Error ? e.message : '无法读取状态';}
  return <div className="overlay opening-state-overlay" onClick={onClose}>
    <section ref={dialog} className="modal opening-state-dialog" role="dialog" aria-modal="true" aria-labelledby="opening-state-title" onClick={e => e.stopPropagation()}>
      <header><div><h2 id="opening-state-title">开局初始状态</h2><p>创建会话时生效的消息级状态；JSON 覆盖会替换整个字段。</p></div><button type="button" className="close" aria-label="关闭初始状态" onClick={onClose}>×</button></header>
      {error ? <p role="alert" className="opening-state-error">无法预览初始状态：{error}</p> : rows.length ? <div className="opening-state-rows">{rows.map(row => <article className="opening-state-row" key={row.name}><div><strong>{row.name}</strong></div><pre><code>{JSON.stringify(row.value, null, 2)}</code></pre></article>)}</div> : <p className="opening-state-empty">没有定义消息级状态。</p>}
    </section>
  </div>;
}
