import React, { useEffect, useRef, useState } from 'react';
import { SR, useSRState } from '@sr/sdk';

const empty = {};

export default function ResponsiveStateUI() {
  const [world] = useSRState('world', empty, { scope: 'message' });
  const [hero] = useSRState('hero', empty, { scope: 'message' });
  const [wide, setWide] = useState(() => window.innerWidth >= 900);
  const [choice, setChoice] = useState<boolean | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const open = choice ?? wide;

  useEffect(() => {
    const media = window.matchMedia('(min-width: 900px)');
    const change = () => setWide(media.matches);
    change(); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (wide || !open) return;
    const el = dialog.current;
    el?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setChoice(false); return; }
      if (event.key !== 'Tab' || !el) return;
      const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
      if (!buttons.length) return;
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); trigger.current?.focus(); };
  }, [wide, open]);

  const content = <><header><h2>当前状态</h2><button onClick={() => setChoice(false)} aria-label="关闭状态栏">关闭</button></header><section><h3>世界</h3><pre>{JSON.stringify(world, null, 2)}</pre></section><section><h3>角色</h3><pre>{JSON.stringify(hero, null, 2)}</pre></section></>;
  return <div className="sr-example-layout">
    <style>{`html,body,#root{height:100%;margin:0}.sr-example-layout{height:100%;display:flex;position:relative;background:#faf9fc;color:#2b2433;font:14px system-ui}.sr-example-chat{flex:1;min-width:0;min-height:0}.sr-example-toggle{position:absolute;right:12px;top:12px;z-index:2;padding:8px 12px;background:white;border:1px solid #d9cfdf;border-radius:8px}.sr-example-panel{width:340px;flex:none;overflow:auto;border-left:1px solid #e7e0eb;background:white;padding:18px}.sr-example-panel header{display:flex;align-items:center;justify-content:space-between}.sr-example-panel h2{font-size:17px}.sr-example-panel h3{font-size:14px}.sr-example-panel button{border:1px solid #ddd3e4;background:white;border-radius:6px;padding:7px}.sr-example-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f7f4f9;padding:12px;border-radius:8px}.sr-example-overlay{position:absolute;inset:0;z-index:3;background:#20162988;display:flex;align-items:center;justify-content:center;padding:16px}.sr-example-overlay .sr-example-panel{width:min(100%,480px);max-height:85%;border:0;border-radius:12px;box-shadow:0 12px 30px #0003}.sr-example-layout button:focus-visible{outline:2px solid #7650a7;outline-offset:2px}`}</style>
    <div className="sr-example-chat"><SR.Chatbot /></div>
    {(!wide || !open) && <button ref={trigger} className="sr-example-toggle" onClick={() => setChoice(true)}>查看状态</button>}
    {wide && open && <aside className="sr-example-panel" aria-label="状态栏">{content}</aside>}
    {!wide && open && <div className="sr-example-overlay" onClick={() => setChoice(false)}><div ref={dialog} className="sr-example-panel" role="dialog" aria-modal="true" aria-label="状态栏" onClick={event => event.stopPropagation()}>{content}</div></div>}
  </div>;
}
