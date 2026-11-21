import AssetImage from './AssetImage';
import React from 'react';

/* 17 位角色的名册（姓名 / 身份 / 评级 / 立绘），构建时注入 */
const ROSTER: Array<{ name: string; identity: string; rating: string; image: string }> = [{"name":"凯莉·露易丝","identity":"贵族寡妇，阿斯特丽德亲妹妹","rating":"A","image":"sr-asset://assets/images/06380fd75304df2758cb9ea4.webp"},{"name":"绫濑遥","identity":"曾在天城贵族管家学院学习专业庄园管理","rating":"A","image":"sr-asset://assets/images/872525009cf6753acc99d9b2.webp"},{"name":"阿斯特丽德·露易丝","identity":"天城现任首相，露易丝家族当主","rating":"S","image":"sr-asset://assets/images/76ba8e37933bd75db7f3b8e7.webp"},{"name":"陈若曦","identity":"天城第一学府学生/平面模特","rating":"A","image":"sr-asset://assets/images/9202b5c8110ffe704944b872.webp"},{"name":"苍穹","identity":"骑士团战斗修女（代号\"天灾\"）","rating":"S","image":"sr-asset://assets/images/425f3ad4e4dc619f3c521d91.webp"},{"name":"伊莎贝拉·罗斯柴尔德","identity":"全球最大军工与以太能源财阀CEO","rating":"S","image":"sr-asset://assets/images/609f3f0a7bdf6698036bcaf7.webp"},{"name":"神宫寺凛","identity":"天城法师塔首席，顶级精神系施法者","rating":"S","image":"sr-asset://assets/images/35a2eeb2c6045dd5c8042ddc.webp"},{"name":"维多利亚","identity":"天城最高法院首席大法官","rating":"A","image":"sr-asset://assets/images/e9cdf4d842578bcda43bf40e.webp"},{"name":"克洛伊","identity":"天城最红全息偶像，国民初恋","rating":"A","image":"sr-asset://assets/images/6b7be90981fe88102e43e1df.webp"},{"name":"塞拉菲娜·阿尔贝蒂","identity":"圣光教会第十七任大主教","rating":"S","image":"sr-asset://assets/images/03f77406a49741cec7494c86.webp"},{"name":"罗莎琳德·海尔加","identity":"天城议会直属骑士团现任团长（第九代）","rating":"S","image":"sr-asset://assets/images/cc2afd7ff625c7bab4e52838.webp"},{"name":"顾衍容","identity":"天城第一学府\"星渊大学\"校长","rating":"A","image":"sr-asset://assets/images/ba8017c8d475470e04f711ce.webp"},{"name":"伊薇特·施奈德","identity":"天城排名前5的生物改造外科医生，\"施奈德精密改造诊所\"创始人兼首席术师","rating":"A","image":"sr-asset://assets/images/a5fc4a2973d8452fec3df953.webp"},{"name":"叶梨莎·艾珐·伍斯特","identity":"海外直播平台头部电竞主播（粉丝量千万级），是凯莉·露易丝的大学学妹和暗恋者","rating":"A","image":"sr-asset://assets/images/12f08b1f0688e99b17fe4927.webp"},{"name":"瑞秋·卡特","identity":"天城下层区黑拳场\"血肉磨坊\"头牌拳手，单亲母亲（女儿艾米7岁），前雇佣兵（服役5年）","rating":"A","image":"sr-asset://assets/images/510fb1d22ceab51d89323b8b.webp"},{"name":"莉娜","identity":"伊甸庄园杂鱼女仆团头头（管理其余约二十名杂鱼女仆）","rating":"B","image":"sr-asset://assets/images/bbdc2efc99972ecb6dfc447d.webp"},{"name":"玛嘉烈·临光","identity":"光辉联邦圆桌骑士（封号「耀」），临光家族长女","rating":"S","image":"sr-asset://assets/images/4bbc6ebdd20bf7ccd1890239.webp"}];

export default function WorldIntroduction() {
  return (
    <div className="mi">
      <style>{`
.mi{--ink:#ece4d3;--muted:#b8ad9a;--gold:#c8a978;--line:#4d463a;--card:#211f1b;background:#17161a;color:var(--ink);padding:clamp(28px,5vw,72px);font:15px/1.85 Georgia,'Noto Serif SC','Songti SC',serif;min-height:100%}
.mi *{box-sizing:border-box}
.mi .wrap{max-width:880px;margin:0 auto}
.mi .eyebrow{color:var(--gold);letter-spacing:.28em;font-size:11px;text-transform:uppercase}
.mi h1{font-size:clamp(32px,6vw,60px);line-height:1.15;margin:.18em 0 .3em;font-weight:500;color:#f6ecd8;letter-spacing:.02em}
.mi .lead{font-size:clamp(16px,2.4vw,20px);color:#dcd2c0;max-width:62ch}
.mi .rule{height:1px;background:linear-gradient(90deg,var(--line),transparent);margin:34px 0}
.mi h2{font-size:22px;font-weight:500;color:#f1e6cf;margin:0 0 14px;display:flex;align-items:center;gap:12px}
.mi h2 .no{color:var(--gold);font-family:Georgia,serif;font-size:13px;letter-spacing:.2em}
.mi .cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}
.mi .pill{border:1px solid var(--line);background:linear-gradient(180deg,#1d1b18,#181613);padding:18px 20px;border-radius:6px}
.mi .pill h3{font-size:15px;color:#e7d9ba;margin:0 0 8px;font-weight:600}
.mi .pill p{font-size:13.5px;color:var(--muted);margin:0;line-height:1.75}
.mi .roster{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.mi .person{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;display:flex;flex-direction:column;align-items:center;padding:12px 10px 12px;gap:8px}
.mi .person .ph{width:72px;height:96px;border-radius:6px;object-fit:cover;border:1px solid #3a3327;background:#000}
.mi .person .ph-fb{width:72px;height:96px;border-radius:6px;border:1px solid #3a3327;display:flex;align-items:center;justify-content:center;color:#6c6250;font-size:11px;background:#000}
.mi .person .nm{font-size:14px;color:#f0e4cb;text-align:center;font-weight:600}
.mi .person .id{font-size:11.5px;color:var(--muted);text-align:center;line-height:1.5}
.mi .person .rt{font-size:10px;letter-spacing:.18em;color:var(--gold);border:1px solid #4a3f2c;border-radius:3px;padding:1px 8px}
.mi .note{font-size:13px;color:var(--muted);margin-top:20px;padding:14px 16px;border-left:2px solid var(--gold);background:#1a1815;border-radius:0 6px 6px 0}
`}</style>
      <div className="wrap">
        <div className="eyebrow">The Manor · World Archive</div>
        <h1>庄园</h1>
        <p className="lead">
          天城的高空庄园之下，是一座由权力、阶级与隐秘身份交织而成的都市。奥伦帝国、光辉联邦与灵枢秘派主导着世界格局；以太魔法与科技并行，塑造了从悬浮庄园到钢铁霓虹再到地下资源区的垂直城市。
        </p>

        <div className="rule" />

        <h2>
          <span className="no">01</span>世界格局
        </h2>
        <div className="cols">
          <div className="pill">
            <h3>奥伦帝国 · 国都天城</h3>
            <p>三大帝国之首，倾向激进秩序。故事的舞台天城是一座垂直分层的大都会，上层悬浮庄园、中层钢铁霓虹、下层资源与生产区彼此隔绝。</p>
          </div>
          <div className="pill">
            <h3>光辉联邦</h3>
            <p>倾向保守秩序。圆桌骑士、商业联合会与「耀骑士」玛嘉烈·临光的立场在这里交锋。</p>
          </div>
          <div className="pill">
            <h3>灵枢秘派</h3>
            <p>带着神秘色彩的神权势力，掌控原域与诸神殿，与世俗帝国保持微妙的距离。</p>
          </div>
        </div>

        <div className="rule" />

        <h2>
          <span className="no">02</span>制度与隐秘身份
        </h2>
        <p className="lead" style={{ fontSize: 15, color: '#c9bfab' }}>
          这个世界存在通过合法程序改变法律身份的制度。人物在公共生活与私人关系之间可能拥有截然不同的身份——首相、法官、主教、骑士团长，回到庄园后是另一重身份。这种「身份反差」构成了庄园故事的核心张力。
        </p>

        <div className="rule" />

        <h2>
          <span className="no">03</span>以太魔法与人物
        </h2>
        <p className="lead" style={{ fontSize: 15, color: '#c9bfab' }}>
          以太魔法融入交通、通讯、治疗与安保。掌握以太者被称为「超凡者」，由一阶至五阶，更有超越五阶的「天灾级」。庄园里，17 位各据一方的女性组成了这座城市的权力光谱。
        </p>

        <div className="rule" />

        <h2>
          <span className="no">04</span>人物名册
        </h2>
        <div className="roster">
          {ROSTER.map(p => (
            <div className="person" key={p.name}>
              {p.image ? (
                <AssetImage className="ph" src={p.image} alt={p.name} loading="lazy" />
              ) : (
                <div className="ph-fb">暂无立绘</div>
              )}
              <span className="nm">{p.name}</span>
              <span className="rt">{p.rating} 级</span>
              <span className="id">{p.identity}</span>
            </div>
          ))}
        </div>

        <div className="note">
          阅读角色档案、庄园规则与各方关系，选择开局进入故事。不同开局对应不同的时间、地点、在场人物与初始状态，也可从中层区作为一名普通人开始，逐步走近这座庄园。
        </div>
      </div>
    </div>
  );
}
