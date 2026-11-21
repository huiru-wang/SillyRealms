import React from 'react';
import { SR } from '@sillyrealms/sdk';
import StatusPanel from './StatusPanel';
import CharacterGallery from './CharacterGallery';

const MIN_WIDTH = 380;

export default function WorldStage() {
  const [open, setOpen] = React.useState(true);
  const [tab, setTab] = React.useState<'status' | 'gallery'>('status');
  const [width, setWidth] = React.useState(MIN_WIDTH);
  const shellRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{ startX: number; startWidth: number } | null>(null);

  const onHandleDown = React.useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: width };
      const move = (ev: PointerEvent) => {
        if (!dragRef.current || !shellRef.current) return;
        const total = shellRef.current.getBoundingClientRect().width;
        const maxW = Math.floor(total / 2);
        const dx = dragRef.current.startX - ev.clientX; // 向左拖 → 加宽
        const next = Math.max(MIN_WIDTH, Math.min(maxW, dragRef.current.startWidth + dx));
        setWidth(next);
      };
      const up = () => {
        dragRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    },
    [width],
  );

  return (
    <div className="ws" ref={shellRef}>
      <style>{`
.ws{height:100%;min-height:0;display:flex;background:#141517;color:#e5dac8;font-family:Georgia,'Noto Serif SC',serif;position:relative}
.ws *{box-sizing:border-box}
.ws-chat{min-width:0;flex:1;height:100%}
.ws-aside{width:var(--aside-w,380px);flex:none;display:flex;flex-direction:column;background:#1c1d1f;border-left:1px solid #50493c;min-height:0;position:relative}
.ws-handle{position:absolute;left:0;top:0;bottom:0;width:6px;margin-left:-3px;cursor:col-resize;z-index:5;touch-action:none}
.ws-handle::before{content:'';position:absolute;left:2px;top:0;bottom:0;width:1px;background:#50493c}
.ws-handle:hover::before,.ws-handle:active::before{background:#b69a70;width:2px;left:1px}
.ws-top{padding:20px 18px 12px;border-bottom:1px solid #4b4437}
.ws-overline{font-size:10px;letter-spacing:.24em;color:#c4a675}
.ws-top h2{font-weight:500;margin:4px 0 14px;font-size:20px;color:#e9dcc2}
.ws-tabs{display:flex;gap:8px;align-items:center}
.ws-tabs button{cursor:pointer;background:transparent;color:#cbbca5;border:1px solid #685b46;padding:8px 13px;font-size:13px;border-radius:4px;font-family:inherit}
.ws-tabs button.on{background:#b69a70;color:#1b1a17;border-color:#b69a70}
.ws-close{margin-left:auto;padding:8px 11px}
.ws-scroll{flex:1;overflow:auto;min-height:0}
.ws-toggle{display:none;position:absolute;right:14px;top:12px;z-index:4;background:#222;color:#d8c6a4;border:1px solid #685b46;border-radius:4px;padding:8px 12px;cursor:pointer;font-family:inherit}
.ws-backdrop{display:none}
@media(max-width:820px){
  .ws-aside{position:fixed;z-index:9;top:0;right:0;height:100%;width:min(92vw,380px);box-shadow:0 0 30px #0009}
  .ws-handle{display:none}
  .ws-backdrop{display:block;position:fixed;inset:0;background:#000a;border:0;z-index:8}
}
`}</style>
      <div className="ws-chat">
        <SR.WorldStory showState={false} />
      </div>
      <button
        type="button"
        className="ws-toggle"
        style={{ display: open ? 'none' : 'block' }}
        onClick={() => setOpen(true)}
      >
        ☰ 状态 / 图鉴
      </button>
      {open && (
        <>
          <button type="button" className="ws-backdrop" aria-label="关闭面板" onClick={() => setOpen(false)} />
          <aside className="ws-aside" style={{ '--aside-w': `${width}px` } as React.CSSProperties}>
            <div className="ws-handle" onPointerDown={onHandleDown} title="拖动调整宽度" />
            <div className="ws-top">
              <div className="ws-overline">The Manor · Archives</div>
              <h2>庄园手记</h2>
              <div className="ws-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'status'}
                  className={tab === 'status' ? 'on' : ''}
                  onClick={() => setTab('status')}
                >
                  状态
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'gallery'}
                  className={tab === 'gallery' ? 'on' : ''}
                  onClick={() => setTab('gallery')}
                >
                  角色图鉴 / CG
                </button>
                <button type="button" className="ws-close" aria-label="关闭" onClick={() => setOpen(false)}>
                  ×
                </button>
              </div>
            </div>
            <div className="ws-scroll">{tab === 'status' ? <StatusPanel /> : <CharacterGallery />}</div>
          </aside>
        </>
      )}
    </div>
  );
}
