import AssetImage from './AssetImage';
import React from 'react';

const PORTRAITS: Record<string, string> = {"凯莉·露易丝":"sr-asset://assets/images/06380fd75304df2758cb9ea4.webp","绫濑遥":"sr-asset://assets/images/872525009cf6753acc99d9b2.webp","阿斯特丽德·露易丝":"sr-asset://assets/images/76ba8e37933bd75db7f3b8e7.webp","陈若曦":"sr-asset://assets/images/9202b5c8110ffe704944b872.webp","苍穹":"sr-asset://assets/images/425f3ad4e4dc619f3c521d91.webp","伊莎贝拉·罗斯柴尔德":"sr-asset://assets/images/609f3f0a7bdf6698036bcaf7.webp","神宫寺凛":"sr-asset://assets/images/35a2eeb2c6045dd5c8042ddc.webp","维多利亚":"sr-asset://assets/images/e9cdf4d842578bcda43bf40e.webp","克洛伊":"sr-asset://assets/images/6b7be90981fe88102e43e1df.webp","塞拉菲娜·阿尔贝蒂":"sr-asset://assets/images/03f77406a49741cec7494c86.webp","罗莎琳德·海尔加":"sr-asset://assets/images/cc2afd7ff625c7bab4e52838.webp","顾衍容":"sr-asset://assets/images/ba8017c8d475470e04f711ce.webp","伊薇特·施奈德":"sr-asset://assets/images/a5fc4a2973d8452fec3df953.webp","叶梨莎·艾珐·伍斯特":"sr-asset://assets/images/12f08b1f0688e99b17fe4927.webp","瑞秋·卡特":"sr-asset://assets/images/510fb1d22ceab51d89323b8b.webp","莉娜":"sr-asset://assets/images/bbdc2efc99972ecb6dfc447d.webp","玛嘉烈·临光":"sr-asset://assets/images/4bbc6ebdd20bf7ccd1890239.webp","伊莎贝拉":"sr-asset://assets/images/609f3f0a7bdf6698036bcaf7.webp"};

export interface OpeningFrameProps {
  title: string;
  premise: string;
  hero?: string;
  world: Array<[string, string]>;
  player: Array<[string, string]>;
  present: string[];
  members: string[];
  hunts: string[];
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="of-group">
      <div className="of-gtitle">{title}</div>
      <div className="of-gbody">{children}</div>
    </div>
  );
}

export default function OpeningFrame(props: OpeningFrameProps) {
  const heroUrl = props.hero ? PORTRAITS[props.hero] : '';
  return (
    <div className="of">
      <style>{`
.of{--ink:#e7dcc4;--muted:#b6ab98;--gold:#c8a978;--line:#4d463a;background:#16151a;color:var(--ink);padding:clamp(22px,4vw,48px);font:15px/1.8 Georgia,'Noto Serif SC','Songti SC',serif;min-height:100%}
.of *{box-sizing:border-box}
.of .wrap{max-width:760px;margin:0 auto}
.of .eyebrow{color:var(--gold);letter-spacing:.26em;font-size:10px}
.of h1{font-size:clamp(24px,5vw,40px);font-weight:500;margin:.2em 0 .4em;color:#f3e8d0}
.of .premise{font-size:16px;color:#d6ccba;line-height:1.9;margin:0 0 22px;max-width:60ch}
.of .hero{max-width:100%;max-height:300px;border-radius:8px;border:1px solid #3a3327;display:block;margin:0 0 22px}
.of h2{font-size:12px;letter-spacing:.22em;color:var(--gold);margin:26px 0 12px;text-transform:uppercase}
.of .group{margin-bottom:14px}
.of .gtitle{font-size:13px;color:#cfc2a6;margin-bottom:6px;font-weight:600}
.of .gbody{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px}
.of .kv{font-size:13px;display:flex;gap:8px;background:#1e1c18;border:1px solid var(--line);border-radius:6px;padding:7px 10px}
.of .kv .k{color:var(--muted);flex-shrink:0}
.of .kv .v{color:#e8ddc5;text-align:right;flex:1;word-break:break-all}
.of .tags{display:flex;flex-wrap:wrap;gap:6px}
.of .tag{font-size:12px;background:#24211b;border:1px solid #4d4536;color:#e0d2b2;border-radius:20px;padding:3px 12px}
.of .empty{font-size:13px;color:#7d7460;font-style:italic}
`}</style>
      <div className="wrap">
        <div className="eyebrow">Opening · 初始状态预览</div>
        <h1>{props.title}</h1>
        {heroUrl ? <AssetImage className="hero" src={heroUrl} alt={props.hero || ''} /> : null}
        <p className="premise">{props.premise}</p>
        <h2>世界</h2>
        <div className="gbody">
          {props.world.map(([k, v]) => (
            <div className="kv" key={k}>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </div>
          ))}
        </div>
        <h2>主角</h2>
        <div className="gbody">
          {props.player.map(([k, v]) => (
            <div className="kv" key={k}>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </div>
          ))}
        </div>
        <h2>开局状态</h2>
        <Group title="在场人物">
          {props.present.length ? (
            <div className="tags">
              {props.present.map(n => (
                <span className="tag" key={n}>
                  {n}
                </span>
              ))}
            </div>
          ) : (
            <span className="empty">暂无</span>
          )}
        </Group>
        <Group title="已收服母畜">
          {props.members.length ? (
            <div className="tags">
              {props.members.map(n => (
                <span className="tag" key={n}>
                  {n}
                </span>
              ))}
            </div>
          ) : (
            <span className="empty">暂无</span>
          )}
        </Group>
        <Group title="狩猎清单">
          {props.hunts.length ? (
            <div className="tags">
              {props.hunts.map(n => (
                <span className="tag" key={n}>
                  {n}
                </span>
              ))}
            </div>
          ) : (
            <span className="empty">暂无</span>
          )}
        </Group>
      </div>
    </div>
  );
}
