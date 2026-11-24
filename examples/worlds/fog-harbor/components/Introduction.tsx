import React from 'react';
import {useSRAssetUrl} from '@sillyrealms/sdk';

// World-detail preview: use assets only. There is no session or writable state here.
const styles = `
.fh-intro{box-sizing:border-box;max-width:980px;margin:0 auto;color:var(--text,#242e33);font-family:var(--font-ui,system-ui,sans-serif)}
.fh-intro *{box-sizing:border-box}
.fh-intro-hero{position:relative;overflow:hidden;border-radius:18px;background:#19303b;min-height:330px;isolation:isolate}
.fh-intro-art{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:68% center;z-index:-2}
.fh-intro-hero::after{content:"";position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,rgba(12,26,33,.9),rgba(12,26,33,.47) 55%,rgba(12,26,33,.03))}
.fh-intro-copy{max-width:510px;padding:42px 38px;color:#f4efe5}
.fh-intro-eyebrow{margin:0 0 17px;color:#dfbc82;font-size:10px;font-weight:600;letter-spacing:.24em}
.fh-intro-copy h1{margin:0;font-family:"Songti SC","Noto Serif CJK SC","SimSun",serif;font-weight:500;font-size:clamp(35px,6vw,54px);line-height:1.3;letter-spacing:.1em}
.fh-intro-lead{margin:20px 0 0;max-width:340px;font-size:14px;line-height:1.95;color:#e0e4df}
.fh-intro-meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin:25px 0 0;color:#e0cba8;font-size:11px;letter-spacing:.05em}
.fh-intro-meta span+span::before{content:"·";margin-right:18px;opacity:.6}
.fh-intro-below{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:36px;padding:27px 6px 8px}
.fh-intro-below h2{margin:0 0 10px;font-size:15px;font-weight:600;letter-spacing:.03em}
.fh-intro-below p{margin:0;color:var(--text-muted,#69777a);font-size:13px;line-height:1.9}
.fh-intro-letter{padding:17px 20px;border-left:2px solid #b58c58;background:color-mix(in srgb,#b58c58 6%,transparent);font-family:"Songti SC","Noto Serif CJK SC","SimSun",serif;font-size:15px;line-height:1.9;color:var(--text,#334144);align-self:start}
.fh-intro-letter small{display:block;margin-top:7px;font-family:var(--font-ui,system-ui,sans-serif);font-size:10px;color:var(--text-muted,#69777a);letter-spacing:.1em}
@media(max-width:600px){.fh-intro-hero{min-height:310px;border-radius:14px}.fh-intro-copy{padding:32px 23px}.fh-intro-art{object-position:64% center}.fh-intro-hero::after{background:linear-gradient(90deg,rgba(12,26,33,.92),rgba(12,26,33,.58) 70%,rgba(12,26,33,.2))}.fh-intro-below{grid-template-columns:1fr;gap:20px;padding:22px 3px 8px}.fh-intro-copy h1{font-size:39px}.fh-intro-lead{font-size:13px;max-width:275px}}
`;

export default function Introduction() {
  const cover = useSRAssetUrl('sr-asset://assets/harbor.svg');
  return <article className="fh-intro">
    <style>{styles}</style>
    <header className="fh-intro-hero">
      {cover && <img className="fh-intro-art" src={cover} alt="" />}
      <div className="fh-intro-copy">
        <p className="fh-intro-eyebrow">A LETTER IN THE FOG</p>
        <h1>雾港来信</h1>
        <p className="fh-intro-lead">一封没有姓名的信，把你带到雾中的港口。<br/>灯还亮着。有人记得它的来处。</p>
        <div className="fh-intro-meta"><span>探索 · 轻悬疑</span><span>3 位角色</span><span>2 个开局</span></div>
      </div>
    </header>
    <section className="fh-intro-below">
      <div><h2>故事从你开口的那一刻开始</h2><p>向守灯人问路，去码头喝一杯热茶，或跟随信使穿过旧街。你决定调查的方向；手记会留下已经发生的故事。</p></div>
      <blockquote className="fh-intro-letter">「寄给仍守着那盏灯的人。」<small>— 信封上唯一的地址</small></blockquote>
    </section>
  </article>;
}
