import AssetImage from './AssetImage';
import React from 'react';
import { useSRState } from '@sillyrealms/sdk';

/* 17 位角色的默认立绘（远程 HTTPS，来源：原卡图鉴 main image） */
const PORTRAITS: Record<string, string> = {"凯莉·露易丝":"sr-asset://assets/images/06380fd75304df2758cb9ea4.webp","绫濑遥":"sr-asset://assets/images/872525009cf6753acc99d9b2.webp","阿斯特丽德·露易丝":"sr-asset://assets/images/76ba8e37933bd75db7f3b8e7.webp","陈若曦":"sr-asset://assets/images/9202b5c8110ffe704944b872.webp","苍穹":"sr-asset://assets/images/425f3ad4e4dc619f3c521d91.webp","伊莎贝拉·罗斯柴尔德":"sr-asset://assets/images/609f3f0a7bdf6698036bcaf7.webp","神宫寺凛":"sr-asset://assets/images/35a2eeb2c6045dd5c8042ddc.webp","维多利亚":"sr-asset://assets/images/e9cdf4d842578bcda43bf40e.webp","克洛伊":"sr-asset://assets/images/6b7be90981fe88102e43e1df.webp","塞拉菲娜·阿尔贝蒂":"sr-asset://assets/images/03f77406a49741cec7494c86.webp","罗莎琳德·海尔加":"sr-asset://assets/images/cc2afd7ff625c7bab4e52838.webp","顾衍容":"sr-asset://assets/images/ba8017c8d475470e04f711ce.webp","伊薇特·施奈德":"sr-asset://assets/images/a5fc4a2973d8452fec3df953.webp","叶梨莎·艾珐·伍斯特":"sr-asset://assets/images/12f08b1f0688e99b17fe4927.webp","瑞秋·卡特":"sr-asset://assets/images/510fb1d22ceab51d89323b8b.webp","莉娜":"sr-asset://assets/images/bbdc2efc99972ecb6dfc447d.webp","玛嘉烈·临光":"sr-asset://assets/images/4bbc6ebdd20bf7ccd1890239.webp","伊莎贝拉":"sr-asset://assets/images/609f3f0a7bdf6698036bcaf7.webp"};

const PHASE_LABELS: Array<[number, string]> = [
  [80, '完全母畜化'],
  [60, '沉溺期'],
  [40, '接受期'],
  [20, '动摇期'],
  [0, '抗拒期'],
];

function phaseOf(value: number): string {
  for (const [min, label] of PHASE_LABELS) {
    if (value > min) return label;
  }
  return '抗拒期';
}

function pick(obj: Record<string, any>, path: string, def: any = ''): any {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur == null) return def;
    cur = cur[part];
  }
  return cur == null ? def : cur;
}

function isAbnormal(val: any): boolean {
  return !!val && val !== '无异常' && val !== '待初始化' && val !== '干燥' && val !== '闭合';
}

function Progress({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="sb-progress">
      <div className="sb-progress-bar">
        <div className="sb-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="sb-progress-text">{value}</span>
    </div>
  );
}

function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const src = PORTRAITS[name];
  const [err, setErr] = React.useState(false);
  if (!src || err) {
    return (
      <div className="sb-avatar" style={{ width: size, height: size }}>
        <span className="sb-avatar-ph">?</span>
      </div>
    );
  }
  return (
    <div className="sb-avatar" style={{ width: size, height: size }}>
      <AssetImage src={src} alt={name} onError={() => setErr(true)} />
    </div>
  );
}

function Portrait({ name }: { name: string }) {
  const src = PORTRAITS[name];
  const [open, setOpen] = React.useState(false);
  const [err, setErr] = React.useState(false);
  if (!src || err) return null;
  return (
    <div className="sb-portrait">
      <button type="button" className="sb-btn sb-btn-blue" onClick={() => setOpen(v => !v)}>
        {open ? '收起立绘' : '展开立绘'}
      </button>
      {open && (
        <div className="sb-large-portrait">
          <AssetImage
            src={src}
            alt={name}
            loading="lazy"
            onClick={() => setOpen(false)}
            onError={() => setErr(true)}
          />
        </div>
      )}
    </div>
  );
}

function OutfitGrid({ cloth }: { cloth: Record<string, any> }) {
  const cells: Array<[string, string]> = [
    ['上衣', '上衣'],
    ['下衣', '下衣'],
    ['内衣', '内衣'],
    ['内裤', '内裤'],
    ['袜子', '袜子'],
    ['鞋子', '鞋子'],
    ['饰品', '饰品'],
  ];
  return (
    <div className="sb-outfit">
      {cells.map(([label, key]) => (
        <div className="sb-outfit-cell" key={key}>
          <span className="sb-outfit-name">{label}</span>
          <span className="sb-outfit-val">{pick(cloth, key, '待初始化') || '待初始化'}</span>
        </div>
      ))}
    </div>
  );
}

function BodyState({ body }: { body: Record<string, any> }) {
  const cells: Array<[string, string]> = [
    ['胸部', '胸部'],
    ['小穴', '小穴'],
    ['后庭', '后庭'],
    ['口腔', '口腔'],
  ];
  return (
    <div className="sb-state-grid">
      {cells.map(([label, key]) => {
        const val = pick(body, key, '无异常');
        return (
          <div className="sb-state-tag" key={key}>
            <span className="sb-tag-name">{label}</span>
            <span className={`sb-tag-val${isAbnormal(val) ? ' alert' : ''}`}>{val}</span>
          </div>
        );
      })}
    </div>
  );
}

function PresentEntry({
  name,
  data,
  open,
  onToggle,
}: {
  name: string;
  data: Record<string, any>;
  open: boolean;
  onToggle: () => void;
}) {
  const identity = pick(data, '身份', '未知');
  const cloth = pick(data, '着装', {}) || {};
  const body = pick(data, '身体状态', {}) || {};
  const thought = pick(data, '内心想法', '');
  return (
    <div className={`sb-person${open ? ' open' : ''}`}>
      <button type="button" className="sb-person-header present" onClick={onToggle}>
        <div className="sb-person-top">
          <Avatar name={name} />
          <span className="sb-entry-name">{name}</span>
          <span className="sb-entry-toggle">▸</span>
        </div>
        <div className="sb-person-id">
          <span className="sb-entry-identity wrap">{identity}</span>
        </div>
      </button>
      {open && (
        <div className="sb-person-body">
          <OutfitGrid cloth={cloth} />
          <BodyState body={body} />
          {thought ? <div className="sb-thought">“{thought}”</div> : null}
          <div className="sb-actions">
            <Portrait name={name} />
          </div>
        </div>
      )}
    </div>
  );
}

function MembersList({ members }: { members: Record<string, any> }) {
  const names = Object.keys(members || {});
  if (!names.length) {
    return <div className="sb-empty">暂无收服记录</div>;
  }
  return (
    <div className="sb-scroll">
      {names.map(name => {
        const data = members[name] || {};
        const rank = pick(data, '母畜等级', 'C');
        const val = Number(pick(data, '母畜值', 0)) || 0;
        const code = pick(data, '母畜代号', '');
        const collar = pick(data, '项圈', '无');
        const known = !!pick(data, '外界知情', false);
        return (
          <div className="sb-list-item" key={name}>
            <div className="sb-list-header">
              <div className="sb-list-name">
                <Avatar name={name} />
                <span className="sb-item-name">{name}</span>
              </div>
              <span className="sb-badge">{rank}级</span>
            </div>
            {code ? (
              <div className="sb-row">
                <span className="sb-label">代号</span>
                <span className="sb-value">{code}</span>
              </div>
            ) : null}
            <div className="sb-row">
              <span className="sb-label">项圈</span>
              <span className="sb-value small">{collar}</span>
            </div>
            <div className="sb-row">
              <span className="sb-label">外界知情</span>
              <span className="sb-value">
                <span className={`sb-badge ${known ? 'public' : 'private'}`}>
                  {known ? '已暴露' : '未暴露'}
                </span>
              </span>
            </div>
            <div className="sb-row">
              <span className="sb-label">驯化阶段</span>
              <span className="sb-value">{phaseOf(val)}</span>
            </div>
            <Progress value={val} />
            <div className="sb-actions">
              <Portrait name={name} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HuntList({ hunts }: { hunts: Record<string, any> }) {
  const names = Object.keys(hunts || {});
  if (!names.length) {
    return <div className="sb-empty">暂无狩猎目标</div>;
  }
  return (
    <div className="sb-scroll">
      {names.map(name => {
        const data = hunts[name] || {};
        const rank = pick(data, '母畜等级', 'C');
        const stage = pick(data, '狩猎阶段', '锁定');
        const identity = pick(data, '身份', '未知');
        const feature = pick(data, '特点', '无');
        const height = pick(data, '身高', '未知');
        const weight = pick(data, '体重', '未知');
        const cup = pick(data, '罩杯', '未知');
        const [open, setOpen] = React.useState(false);
        return (
          <div className={`sb-person hunt${open ? ' open' : ''}`} key={name}>
            <button type="button" className="sb-person-header hunt" onClick={() => setOpen(v => !v)}>
              <div className="sb-person-top">
                <Avatar name={name} />
                <span className="sb-hint">点击展开</span>
                <span className="sb-entry-toggle">▸</span>
              </div>
              <div className="sb-hunt-name">
                <span className="sb-entry-name">{name}</span>
              </div>
              <div className="sb-hunt-rank">
                <span className="sb-badge gray">{rank}级</span>
              </div>
              <div className="sb-hunt-id">
                <span className="sb-entry-identity wrap">{identity}</span>
              </div>
            </button>
            {open && (
              <div className="sb-person-body">
                <div className="sb-state-grid">
                  <div className="sb-state-tag">
                    <span className="sb-tag-name">身高</span>
                    <span className="sb-tag-val">{height}cm</span>
                  </div>
                  <div className="sb-state-tag">
                    <span className="sb-tag-name">体重</span>
                    <span className="sb-tag-val">{weight}kg</span>
                  </div>
                  <div className="sb-state-tag">
                    <span className="sb-tag-name">罩杯</span>
                    <span className="sb-tag-val">{cup}</span>
                  </div>
                  <div className="sb-state-tag">
                    <span className="sb-tag-name">母畜等级</span>
                    <span className="sb-tag-val">{rank}级</span>
                  </div>
                </div>
                <div className="sb-row">
                  <span className="sb-label">身份</span>
                  <span className="sb-value">{identity}</span>
                </div>
                <div className="sb-row">
                  <span className="sb-label">特点</span>
                  <span className="sb-value small">{feature}</span>
                </div>
                <div className="sb-row">
                  <span className="sb-label">狩猎阶段</span>
                  <span className="sb-value bold">{stage}</span>
                </div>
                <div className="sb-actions">
                  <Portrait name={name} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function StatusPanel() {
  const [world] = useSRState('世界', {});
  const [player] = useSRState('主角', {});
  const [present] = useSRState('在场人物', {});
  const [members] = useSRState('已收服母畜', {});
  const [hunts] = useSRState('狩猎清单', {});
  const [tab, setTab] = React.useState<'present' | 'archive'>('present');
  const [openPresent, setOpenPresent] = React.useState<string[]>([]);

  const togglePresent = (name: string) => {
    setOpenPresent(prev => {
      if (prev.includes(name)) return prev.filter(n => n !== name);
      const next = [...prev, name];
      return next.length > 2 ? next.slice(1) : next;
    });
  };

  const date = pick(world, '当前日期', '未知日期');
  const time = pick(world, '当前时刻', '--:--');
  const period = pick(world, '当日时段', '日间');
  const loc = pick(world, '当前地点', '伊甸庄园');

  const cloth = pick(player, '着装', {}) || {};
  const play = pick(player, '当前调教玩法', '无');
  const rep = Number(pick(player, '庄园声望', 50)) || 0;

  return (
    <div className="sb-container">
      <style>{`
.sb-container{--bg:#FEFEFE;--card:#F5F5F5;--ink:#1A1A1A;--muted:#666;--border:#D0D0D0;--accent:#000;--pg:#E0E0E0;--delete:#8b0000;--blue:#1a5fa8;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:var(--ink);background:var(--bg);border:1px solid var(--border);border-radius:2px;
  position:relative;overflow:hidden;line-height:1.5}
.sb-container *{box-sizing:border-box}
.sb-header{display:flex;justify-content:space-between;align-items:center;padding:0 14px;height:40px;border-bottom:1px solid var(--border);user-select:none}
.sb-header .group{display:flex;align-items:baseline;gap:8px}
.sb-time{font-size:16px;font-weight:700}
.sb-loc{font-size:11px;color:var(--muted)}
.sb-cards{display:flex;flex-direction:column;gap:14px;padding:14px}
.sb-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:14px}
.sb-card{background:var(--card);border:1px solid var(--border);box-shadow:0 1px 2px rgba(0,0,0,.05);padding:14px;border-radius:2px;outline:1px solid var(--border);outline-offset:2px;position:relative}
.sb-card-title{font-family:Georgia,'Times New Roman',serif;font-size:14px;letter-spacing:.05em;margin-bottom:8px;font-variant:small-caps;font-weight:600;display:flex;align-items:center;gap:8px}
.sb-divider{flex:1;height:1px;background:var(--border);position:relative}
.sb-divider::after{content:'';position:absolute;top:-2px;left:50%;width:5px;height:5px;background:var(--accent);transform:translateX(-50%) rotate(45deg)}
.sb-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:6px;font-size:13px}
.sb-row:last-child{margin-bottom:0}
.sb-label{color:var(--muted);font-size:.9em}
.sb-value{font-weight:500;text-align:right;max-width:70%;word-break:break-all}
.sb-value.small{font-size:.85em}
.sb-value.bold{font-weight:700}
.sb-outfit{display:grid;grid-template-columns:repeat(auto-fit,minmax(82px,1fr));gap:6px;margin:6px 0 10px;background:rgba(0,0,0,.03);padding:8px;border-radius:4px}
.sb-outfit-cell{display:flex;flex-direction:column;align-items:center;text-align:center}
.sb-outfit-name{font-size:.7em;color:var(--muted);margin-bottom:2px}
.sb-outfit-val{font-size:.8em;font-weight:600;line-height:1.3;word-break:break-all}
.sb-progress{display:flex;align-items:center;gap:10px;margin:6px 0}
.sb-progress-bar{flex:1;height:8px;background:var(--pg);border-radius:4px;overflow:hidden}
.sb-progress-fill{height:100%;background:var(--accent);border-radius:4px;transition:width .4s}
.sb-progress-text{font-size:.85em;font-weight:600;min-width:2.5em;text-align:right}
.sb-tabs{display:flex;border-bottom:2px solid var(--accent)}
.sb-tab{flex:1;text-align:center;font-family:Georgia,serif;font-size:14px;font-weight:700;color:var(--muted);background:none;border:none;padding:8px 0;cursor:pointer;position:relative;letter-spacing:.05em}
.sb-tab.active{color:var(--accent)}
.sb-tab.active::after{content:'';position:absolute;bottom:-2px;left:0;right:0;height:4px;background:var(--accent)}
.sb-tab-pane{display:flex;flex-direction:column;gap:12px;margin-top:12px}
.sb-person{border:1px solid var(--border);background:var(--card);border-radius:2px;outline:1px solid var(--border);outline-offset:2px;width:100%}
.sb-person-header{display:flex;flex-direction:column;align-items:stretch;gap:3px;padding:10px 12px;cursor:pointer;user-select:none;border:none;background:transparent;text-align:left;width:100%;font:inherit;color:inherit}
.sb-person-header:hover{background:rgba(0,0,0,.03)}
.sb-person-top{display:flex;align-items:center;gap:8px;width:100%}
.sb-person-id,.sb-hunt-id{width:100%}
.sb-hunt-name,.sb-hunt-rank{display:flex;align-items:center;width:100%}
.sb-entry-name{font-weight:700;font-family:Georgia,serif;white-space:nowrap;flex-shrink:0}
.sb-entry-identity{font-size:.8em;color:var(--muted)}
.sb-entry-identity.wrap{white-space:normal;word-break:break-all;line-height:1.35}
.sb-entry-toggle{margin-left:auto;color:var(--muted);transition:transform .3s}
.sb-person.open .sb-entry-toggle{transform:rotate(90deg)}
.sb-hint{display:inline-block;background:#000;color:#fff;font-size:.7em;padding:2px 8px;border-radius:3px;white-space:nowrap}
.sb-person-body{padding:10px 12px;border-top:1px solid var(--border)}
.sb-state-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0;background:rgba(0,0,0,.03);padding:8px;border-radius:4px}
.sb-state-tag{display:flex;flex-direction:column;font-size:.85em}
.sb-tag-name{font-size:.8em;color:var(--muted)}
.sb-tag-val{font-weight:700}
.sb-tag-val.alert{color:var(--delete)}
.sb-thought{padding:8px;border-left:3px solid var(--accent);font-style:italic;font-size:13px;line-height:1.5;background:rgba(0,0,0,.02);border-radius:0 4px 4px 0;margin-top:6px}
.sb-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.sb-btn{padding:7px 10px;cursor:pointer;font-size:12px;font-weight:600;color:var(--ink);background:rgba(0,0,0,.04);border:1px solid var(--border);border-radius:4px}
.sb-btn-blue{color:var(--blue);border-color:rgba(26,95,168,.3);background:rgba(26,95,168,.06)}
.sb-large-portrait{margin-top:8px;border:1px solid var(--border);border-radius:4px;background:rgba(0,0,0,.03);text-align:center;padding:6px}
.sb-large-portrait img{max-width:100%;max-height:300px;object-fit:contain;cursor:zoom-in;border-radius:2px}
.sb-scroll{max-height:420px;overflow-y:auto;padding-right:4px}
.sb-list-item{border-bottom:1px dashed var(--border);padding:10px 0}
.sb-list-item:last-child{border-bottom:none}
.sb-list-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.sb-list-name{display:flex;align-items:center;gap:6px}
.sb-item-name{font-weight:700;font-family:Georgia,serif}
.sb-badge{font-size:.72em;padding:2px 8px;background:var(--accent);color:var(--bg);border-radius:2px;white-space:nowrap}
.sb-badge.public{background:var(--blue)}
.sb-badge.private{background:#666}
.sb-badge.gray{background:#555}
.sb-avatar{border-radius:50%;border:1px solid var(--border);overflow:hidden;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.05)}
.sb-avatar img{width:100%;height:100%;object-fit:cover}
.sb-avatar-ph{color:var(--muted);font-size:12px}
.sb-empty{padding:12px;color:var(--muted);font-size:13px}
@media(max-width:480px){.sb-entry-name{font-size:.95em}.sb-entry-identity{font-size:.72em}.sb-hint{font-size:.65em}}
`}</style>
      <div className="sb-header">
        <div className="group">
          <span className="sb-time">{time}</span>
          <span className="sb-loc">{loc}</span>
        </div>
      </div>
      <div className="sb-cards">
        <div className="sb-overview">
          <div className="sb-card">
            <div className="sb-card-title">
              世界环境<span className="sb-divider" />
            </div>
            <div className="sb-row">
              <span className="sb-label">日期</span>
              <span className="sb-value">{date}</span>
            </div>
            <div className="sb-row">
              <span className="sb-label">时刻</span>
              <span className="sb-value">{time}</span>
            </div>
            <div className="sb-row">
              <span className="sb-label">时段</span>
              <span className="sb-value">{period}</span>
            </div>
            <div className="sb-row">
              <span className="sb-label">地点</span>
              <span className="sb-value">{loc}</span>
            </div>
          </div>
          <div className="sb-card">
            <div className="sb-card-title">
              主人状态<span className="sb-divider" />
            </div>
            <div className="sb-outfit">
              <div className="sb-outfit-cell">
                <span className="sb-outfit-name">上衣</span>
                <span className="sb-outfit-val">{pick(cloth, '衣服', '待初始化') || '待初始化'}</span>
              </div>
              <div className="sb-outfit-cell">
                <span className="sb-outfit-name">下装</span>
                <span className="sb-outfit-val">{pick(cloth, '裤子', '待初始化') || '待初始化'}</span>
              </div>
              <div className="sb-outfit-cell">
                <span className="sb-outfit-name">鞋子</span>
                <span className="sb-outfit-val">{pick(cloth, '鞋子', '待初始化') || '待初始化'}</span>
              </div>
            </div>
            <div className="sb-row">
              <span className="sb-label">当前玩法</span>
              <span className="sb-value">{play}</span>
            </div>
            <div className="sb-row">
              <span className="sb-label">庄园声望</span>
            </div>
            <Progress value={rep} />
          </div>
        </div>
        <div className="sb-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'present'}
            className={`sb-tab${tab === 'present' ? ' active' : ''}`}
            onClick={() => setTab('present')}
          >
            在场人物状态
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'archive'}
            className={`sb-tab${tab === 'archive' ? ' active' : ''}`}
            onClick={() => setTab('archive')}
          >
            庄园名册与档案
          </button>
        </div>
        {tab === 'present' ? (
          <div className="sb-tab-pane">
            {Object.keys(present || {}).length === 0 ? (
              <div className="sb-empty">当前场景暂无其他人物在场。</div>
            ) : (
              Object.entries(present || {}).map(([name, data]) => (
                <PresentEntry
                  key={name}
                  name={name}
                  data={data as Record<string, any>}
                  open={openPresent.includes(name)}
                  onToggle={() => togglePresent(name)}
                />
              ))
            )}
          </div>
        ) : (
          <div className="sb-tab-pane">
            <div className="sb-overview">
              <div className="sb-card">
                <div className="sb-card-title">
                  已收服母畜<span className="sb-divider" />
                </div>
                <MembersList members={members as Record<string, any>} />
              </div>
              <div className="sb-card">
                <div className="sb-card-title">
                  狩猎清单<span className="sb-divider" />
                </div>
                <HuntList hunts={hunts as Record<string, any>} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
