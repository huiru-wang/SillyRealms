import React from 'react';
import {SR, useSRActionSuggestions, useSRAssetUrl, useSRComposerButtons, useSRSession, useSRStageSnapshot, useSRState} from '@sillyrealms/sdk';

// The platform owns the conversation and composer. This component only combines
// the official story and action components with three reactive state roots.
const styles = `
.fh-stage{box-sizing:border-box;height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden;padding-bottom:var(--sr-story-bottom-inset,0px);color:var(--sr-story-text,var(--text,#263138));background:var(--sr-story-bg,var(--bg,#f7f7f3));font-family:var(--font-ui,system-ui,sans-serif);--fh-muted:var(--sr-story-muted,var(--text-muted,#727e80));--fh-line:var(--sr-story-line,var(--border,#e2e5df));--fh-accent:#b58c58}
.fh-stage *{box-sizing:border-box}
.fh-stage-header{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 22px;border-bottom:1px solid var(--fh-line);min-height:64px}
.fh-stage-brand{display:flex;align-items:center;gap:11px;min-width:0}
.fh-stage-mark{width:30px;height:36px;flex:none;color:var(--fh-accent)}
.fh-stage-brand h1{margin:0;font-family:"Songti SC","Noto Serif CJK SC","SimSun",serif;font-weight:500;font-size:21px;line-height:1.3;letter-spacing:.09em}
.fh-stage-subtitle{margin:3px 0 0;font-size:9px;letter-spacing:.18em;color:var(--fh-muted)}
.fh-stage-status{display:flex;align-items:center;gap:7px;font-size:10px;color:var(--fh-muted);white-space:nowrap}
.fh-stage-status::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--fh-accent);opacity:.8}
.fh-notes-toggle{display:none;appearance:none;min-height:32px;border:1px solid var(--fh-line);border-radius:8px;padding:5px 11px;color:inherit;background:transparent;font-size:12px}
.fh-notes-toggle:focus-visible{outline:2px solid var(--focus,#b58c58);outline-offset:3px}
.fh-stage-body{flex:1;min-height:0;min-width:0;display:grid;grid-template-columns:minmax(0,1fr) 232px}
.fh-reading{min-height:0;min-width:0;display:flex;flex-direction:column}
.fh-story{flex:1;min-height:0;min-width:0;--sr-story-reading-bottom-space:16px;--sr-story-content-bottom-inset:0px}
.fh-actions{flex:none;min-height:0;max-height:clamp(calc(var(--control-height,36px) + 20px),30%,240px);overflow:auto;overscroll-behavior:contain;padding:10px 16px}
.fh-notes{min-width:0;overflow:auto;overscroll-behavior:contain;padding:23px 20px 26px;border-left:1px solid var(--fh-line);background:color-mix(in srgb,var(--fh-accent) 3%,transparent);scrollbar-width:thin}
.fh-notes-heading{display:flex;align-items:center;gap:10px;margin-bottom:24px}
.fh-notes-heading img{display:block;width:34px;height:34px;border-radius:50%;border:1px solid color-mix(in srgb,var(--fh-accent) 25%,transparent)}
.fh-notes-heading h2{font-size:12px;font-weight:600;margin:0;letter-spacing:.06em}
.fh-notes-heading p{font-size:9px;color:var(--fh-muted);margin:3px 0 0;letter-spacing:.12em}
.fh-notes-label{margin:0 0 8px;font-size:10px;color:var(--fh-muted);letter-spacing:.06em}
.fh-notes-goal{margin:0;font-family:"Songti SC","Noto Serif CJK SC","SimSun",serif;font-size:17px;line-height:1.6;overflow-wrap:anywhere}
.fh-notes-divider{height:1px;background:var(--fh-line);margin:21px 0}
.fh-notes-money{display:flex;align-items:baseline;gap:7px;margin:0;color:var(--fh-accent);font-variant-numeric:tabular-nums}
.fh-notes-money strong{font-size:29px;font-weight:500;line-height:1.2;letter-spacing:-.04em}
.fh-notes-money span{font-size:11px;color:var(--fh-muted)}
.fh-notes-clues{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.fh-notes-clues li{position:relative;padding-left:13px;font-size:12px;line-height:1.7;overflow-wrap:anywhere}
.fh-notes-clues li::before{content:"";position:absolute;left:0;top:8px;width:4px;height:4px;border:1px solid var(--fh-accent);border-radius:50%}
.fh-notes-empty,.fh-notes-error{margin:0;font-size:12px;line-height:1.8;color:var(--fh-muted)}
.fh-notes-error{margin-bottom:14px;color:var(--danger,#b65349)}
.fh-notes-foot{margin:24px 0 0;padding-top:13px;border-top:1px solid var(--fh-line);font-size:10px;line-height:1.8;color:var(--fh-muted)}
@media(max-width:760px){.fh-stage-header{padding:10px 14px;min-height:60px}.fh-stage-brand h1{font-size:19px}.fh-stage-status{display:none}.fh-notes-toggle{display:block}.fh-stage-body{display:flex;flex-direction:column}.fh-reading{flex:1}.fh-notes{order:-1;flex:none;max-height:38%;padding:14px 16px;border-left:0;border-bottom:1px solid var(--fh-line)}.fh-notes[data-open="false"]{display:none}.fh-notes-heading{display:none}.fh-notes-divider{margin:12px 0}.fh-notes-goal{font-size:16px}.fh-notes-money strong{font-size:23px}.fh-notes-foot{display:none}.fh-notes-clues{gap:6px}}
`;

export default function HarborStage() {
  const snapshot = useSRStageSnapshot();
  const {items} = useSRActionSuggestions();
  const session = useSRSession();
  const portrait = useSRAssetUrl('sr-asset://assets/traveler.svg');
  const [coins] = useSRState<number>('coins', 0);
  const [clues] = useSRState<string[]>('clues', []);
  const [quest] = useSRState<string>('quest', '');
  const [notesOpen, setNotesOpen] = React.useState(false);
  const ready = !snapshot.stateLoading && !snapshot.stateError;
  const knownClues = Array.isArray(clues) ? clues.filter(item => typeof item === 'string') : [];

  // This fills an editable draft; it does not send a message or change state.
  useSRComposerButtons([{
    id: 'inspect-letter',
    label: '看看信封',
    disabled: !snapshot.connected || snapshot.sending || !!snapshot.activeRunId || snapshot.history.loading,
    onClick: () => session.setDraft('我仔细查看信封上的地址与灯塔印记，再向林舟询问它的来历。'),
  }]);

  return <main className="fh-stage">
    <style>{styles}</style>
    <header className="fh-stage-header">
      <div className="fh-stage-brand">
        <svg className="fh-stage-mark" viewBox="0 0 30 36" aria-hidden="true">
          <path d="M10 13h10l2 20H8l2-20ZM8 12h14M10 7h10v5H10ZM15 2l6 5H9l6-5Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
          <path d="M13 33v-6h4v6M15 18v3M4 9H1m28 0h-3" fill="none" stroke="currentColor" strokeWidth="1.3"/>
        </svg>
        <div><h1>雾港来信</h1><p className="fh-stage-subtitle">A LETTER IN THE FOG</p></div>
      </div>
      <span className="fh-stage-status">{snapshot.connected ? snapshot.activeRunId ? '故事正在继续' : '灯还亮着' : '正在连接故事'}</span>
      <button className="fh-notes-toggle" type="button" aria-controls="harbor-notebook" aria-expanded={notesOpen} onClick={() => setNotesOpen(value => !value)}>
        {notesOpen ? '收起手记' : '旅人手记'}
      </button>
    </header>
    <div className="fh-stage-body">
      <div className="fh-reading">
        <section className="fh-story" aria-label="雾港的故事"><SR.WorldStory showState={false}/></section>
        {items.length > 0 && <div className="fh-actions"><SR.ActionSuggestions/></div>}
      </div>
      <aside className="fh-notes" id="harbor-notebook" data-open={notesOpen} aria-label="旅人手记">
        <div className="fh-notes-heading">{portrait && <img src={portrait} alt=""/>}<div><h2>旅人手记</h2><p>THE TRAVELER'S NOTES</p></div></div>
        {snapshot.stateError && <p className="fh-notes-error" role="status">手记暂时无法同步，请稍后重试。</p>}
        <p className="fh-notes-label">此刻的目标</p>
        <p className="fh-notes-goal">{ready && typeof quest === 'string' && quest ? quest : '正在翻开手记…'}</p>
        <div className="fh-notes-divider"/>
        <p className="fh-notes-label">口袋里</p>
        <p className="fh-notes-money"><strong>{ready && typeof coins === 'number' && Number.isFinite(coins) ? coins : '—'}</strong><span>枚银币</span></p>
        <div className="fh-notes-divider"/>
        <p className="fh-notes-label">已经确认的线索{ready ? ' · ' + knownClues.length : ''}</p>
        {!ready ? <p className="fh-notes-empty">正在读取…</p> : knownClues.length ? <ul className="fh-notes-clues">{knownClues.map((clue, index) => <li key={index}>{clue}</li>)}</ul> : <p className="fh-notes-empty">纸页还是空白的。<br/>也许可以先问问信封的来历。</p>}
        <p className="fh-notes-foot">写下已知的事，<br/>为未知的事留一盏灯。</p>
      </aside>
    </div>
  </main>;
}
