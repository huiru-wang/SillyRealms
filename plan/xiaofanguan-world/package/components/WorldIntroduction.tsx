/*
 * 世界卡详情组件：只读展示，不访问会话或宿主 DOM；图片仅从世界卡包内加载。
 * 层级：世界与玩家身份 > 家人关系 > 日常与地域；主操作：认识店里的人。
 * Layout first: two-column hero, one character panel, three everyday passages.
 * Tokens: generated paper ramp 100/200/300/700/900; stove 500/700.
 * Space: 8/16/24/32/48/64/96; type: 14/16/20/24/32/48/96.
 * 宿主详情页采用内容高度，保留自己的导航，不套用营销站点全屏分节。
 */
import { useSRAssetUrl } from '@sillyrealms/sdk';

const portraits = {
  user: 'sr-asset://assets/images/keeper.jpg',
  yuer: 'sr-asset://assets/images/li-yuer.jpg',
  niaoer: 'sr-asset://assets/images/li-niaoer.jpg',
};

const people = [
  {id:'user', name:'掌柜', role:'你所扮演的人', detail:'做菜 · 喝茶 · 照看这个家', image:portraits.user,
    first:'你在京城的巷弄里，开着一家很小的饭馆。',
    body:'清早卸下门板，去市集挑些新鲜菜蔬；回来烧水、起灶，想想今天给熟客做些什么。闲下来，就往老藤椅上一靠，喝一碗粗茶。',
    note:'鱼儿和鸟儿十岁那年，你将卖身葬父的姐妹带回了家。如今她们都到了及笄之年，说是店里的小二，早已是你最亲近的家人。'},
  {id:'li-yuer', name:'李鱼儿', role:'姐姐 · 店里的账房', detail:'蓝底碎花裙袄 · 木簪 · 一本细账', image:portraits.yuer,
    first:'每一文钱都记得清，也把一家人的日子放在心上。',
    body:'她说话温柔，主意却很稳。买菜要新鲜，花钱有打算；你想添件用不上的贵物，她便笑着把账本推过来。她的坚持，是想让这个家过得更好。',
    note:'午后不忙，她会坐在柜台一角看书、练字，遇上不认识的字便来问你。她惦记你的身体，也总想着给妹妹添件合身的衣裳。'},
  {id:'li-niaoer', name:'李鸟儿', role:'妹妹 · 店里的跑堂', detail:'青布短褐 · 一声招呼 · 满街的趣事', image:portraits.niaoer,
    first:'嘴上最不饶人，手上却总在帮忙。',
    body:'她端茶、擦桌、招呼客人，忙起来风风火火。新菜太咸了，她一定第一个说；哪家的菜新鲜便宜，哪家的肉秤不准，她也门儿清。',
    note:'得空想去看一场皮影戏，回店就讲起街坊的新鲜事。她还有个藏着的小心愿：把女红练好，亲手给姐姐和你缝衣裳、做手套。'},
];

const css = `
.xf-world{--paper:#fcfbee;--surface:#ebe8d4;--line:#d8d3bb;--ink:#36261c;--muted:#776150;--accent:#9b462b;--deep:#7e2d1a;--space:clamp(24px,5vw,64px);color:var(--ink);background:var(--paper);font:400 16px/1.85 'PingFang SC','Microsoft YaHei',sans-serif;width:100%;isolation:isolate;color-scheme:light}
.xf-world *{box-sizing:border-box}.xf-world h1,.xf-world h2,.xf-world h3,.xf-world p,.xf-world figure{margin:0}.xf-world button{font:inherit}.xf-world img{display:block;width:100%;height:100%;object-fit:cover}.xf-world .xf-wrap{width:min(1120px,100% - var(--space)*2);margin-inline:auto}.xf-world .xf-serif{font-family:'Songti SC','STSong','Noto Serif CJK SC',serif;font-weight:400}.xf-world .xf-eyebrow{font-size:14px;color:var(--muted);letter-spacing:.16em}.xf-world .xf-top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-block:24px;border-bottom:1px solid var(--line)}.xf-world .xf-mark{font-size:20px;letter-spacing:.18em}.xf-world .xf-seal{color:var(--accent);border:1px solid var(--accent);padding:0 8px;line-height:1.7;font-size:14px;margin-right:16px}.xf-world .xf-topnote{font-size:14px;color:var(--muted)}
.xf-world .xf-hero{display:grid;grid-template-columns:1.1fr 1fr;align-items:center;gap:64px;padding-block:64px}.xf-world .xf-hero h1{font-size:clamp(64px,8vw,96px);line-height:1.2;letter-spacing:.1em;margin-top:24px}.xf-world .xf-subtitle{font-size:clamp(24px,3vw,32px);line-height:1.6;margin-top:24px}.xf-world .xf-intro{margin-top:24px;max-width:26em;color:var(--muted)}.xf-world .xf-heroimage{aspect-ratio:2/3;max-height:600px;position:relative;background:var(--surface);overflow:hidden}.xf-world .xf-heroimage img{object-fit:contain}.xf-world .xf-cta{display:inline-flex;align-items:center;justify-content:space-between;gap:32px;margin-top:32px;padding:12px 24px;min-height:48px;background:var(--accent);color:var(--paper);border:0;cursor:pointer;transition:background .15s,transform .15s}.xf-world .xf-cta:hover{background:var(--deep);transform:translateY(-1px)}.xf-world .xf-cta:active{transform:translateY(1px)}.xf-world button:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.xf-world .xf-hero-meta{font-size:14px;color:var(--muted);margin-top:24px;word-spacing:8px}
.xf-world .xf-people{border-top:1px solid var(--line);padding-block:64px;scroll-margin-top:24px}.xf-world .xf-heading{display:flex;align-items:baseline;justify-content:space-between;gap:24px;margin-bottom:32px}.xf-world h2{font-size:clamp(24px,3.3vw,32px);line-height:1.5}.xf-world .xf-switcher{display:flex;gap:8px;border-bottom:1px solid var(--line);margin-bottom:32px}.xf-world .xf-personbutton{padding:12px 24px;min-height:48px;color:var(--muted);border:0;border-bottom:2px solid transparent;background:transparent;cursor:pointer;transition:background .15s,color .15s}.xf-world .xf-personbutton[aria-pressed=true]{border-bottom-color:var(--accent);color:var(--accent);font-weight:600}.xf-world .xf-personbutton:hover{background:var(--surface);color:var(--ink)}
.xf-world .xf-person{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:64px;align-items:center}.xf-world .xf-portrait{aspect-ratio:1;background:var(--surface);overflow:hidden;position:relative}.xf-world .xf-portrait[data-person=user] img{object-position:50% 19%}.xf-world .xf-person h3{font-size:48px;line-height:1.3;margin-top:16px;letter-spacing:.08em}.xf-world .xf-detail{font-size:14px;color:var(--muted);margin-top:16px}.xf-world .xf-lead{font-size:20px;line-height:1.75;margin-top:24px}.xf-world .xf-body{color:var(--muted);margin-top:16px;max-width:30em}.xf-world .xf-note{border-left:2px solid var(--line);padding-left:24px;margin-top:24px;color:var(--muted);font-size:14px;max-width:34em}.xf-world .xf-fallback{min-height:100%;display:flex;align-items:center;justify-content:center;padding:32px;color:var(--muted);text-align:center}
.xf-world .xf-days{background:var(--surface);padding-block:64px}.xf-world .xf-daysgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:48px;margin-top:32px}.xf-world .xf-day{border-top:1px solid var(--muted);padding-top:24px}.xf-world .xf-day h3{font-size:24px;margin-block:8px 16px}.xf-world .xf-day p{font-size:14px;color:var(--muted)}.xf-world .xf-day .xf-number{font-size:14px;color:var(--accent)}
.xf-world .xf-foot{padding-block:48px}.xf-world .xf-foot p{max-width:48em;color:var(--muted);font-size:14px}.xf-world .xf-close{margin-top:32px!important;font-size:24px!important;color:var(--ink)!important}.xf-world .xf-bottom{display:flex;justify-content:space-between;gap:16px;border-top:1px solid var(--line);margin-top:32px;padding-top:24px;font-size:14px;color:var(--muted)}
.xf-world .xf-heroimage{justify-self:end}
@media(min-width:761px) and (prefers-reduced-motion:no-preference){.xf-world .xf-hero-copy{animation:xf-arrive .6s both}.xf-world .xf-heroimage{animation:xf-arrive .7s .08s both}@keyframes xf-arrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
@media(max-width:760px){.xf-world{--space:24px}.xf-world .xf-top{padding-block:16px}.xf-world .xf-topnote{font-size:12px}.xf-world .xf-seal{margin-right:8px}.xf-world .xf-hero{grid-template-columns:1fr;gap:32px;padding-block:48px}.xf-world .xf-hero h1{font-size:64px;margin-top:16px}.xf-world .xf-subtitle{font-size:24px;margin-top:16px}.xf-world .xf-intro{margin-top:16px}.xf-world .xf-cta{width:100%;margin-top:24px}.xf-world .xf-heroimage{max-height:none;width:100%;aspect-ratio:2/3}.xf-world .xf-heading{display:block}.xf-world .xf-heading .xf-eyebrow{margin-top:8px}.xf-world .xf-people{padding-block:48px}.xf-world .xf-personbutton{flex:1;padding-inline:8px}.xf-world .xf-person{grid-template-columns:1fr;gap:32px}.xf-world .xf-person h3{font-size:32px;margin-top:8px}.xf-world .xf-note{padding-left:16px}.xf-world .xf-days{padding-block:48px}.xf-world .xf-daysgrid{grid-template-columns:1fr;gap:32px}.xf-world .xf-day{padding-top:16px}.xf-world .xf-day h3{margin-bottom:8px}.xf-world .xf-foot{padding-block:32px}.xf-world .xf-bottom{flex-wrap:wrap}.xf-world .xf-close{font-size:20px!important}}
@media(prefers-reduced-motion:reduce){.xf-world *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

function Portrait({src,alt}:{src:string;alt:string}){
  const assetUrl=useSRAssetUrl(src);
  const [failed,setFailed]=React.useState(false);
  React.useEffect(()=>setFailed(false),[src,assetUrl]);
  return failed || !assetUrl ? <div className="xf-fallback" role="img" aria-label={alt}>{alt} · 图片暂不可用</div> : <img key={assetUrl} src={assetUrl} alt={alt} decoding="async" onError={()=>setFailed(true)}/>;
}

export default function WorldIntroduction(){
  const [selected,setSelected]=React.useState(1);
  const family=React.useRef<HTMLElement>(null);
  const person=people[selected];
  return <article className="xf-world" aria-label="小饭馆世界介绍">
    <style>{css}</style>
    <div className="xf-wrap xf-top"><span className="xf-mark xf-serif"><span className="xf-seal">家常</span>小饭馆</span><span className="xf-topnote">京城巷弄 · 一日三餐</span></div>
    <main>
      <section className="xf-wrap xf-hero" aria-labelledby="xf-title" data-enter="">
        <div className="xf-hero-copy"><p className="xf-eyebrow">大离京城 / 市井日常</p><h1 className="xf-serif" id="xf-title">小饭馆</h1><p className="xf-serif xf-subtitle">灶火正暖，<br/>日子慢慢过。</p><p className="xf-intro">巷口的包子铺冒起白烟，店里的算盘响了几声。你是这间小饭馆的掌柜，和鱼儿、鸟儿一起，把寻常日子过得有滋有味。</p><button type="button" className="xf-cta" onClick={()=>{family.current?.scrollIntoView({behavior:'auto',block:'start'});family.current?.focus({preventScroll:true});}}>认识店里的人<span aria-hidden="true">↓</span></button><p className="xf-hero-meta">家常饭菜 · 姐妹相伴 · 街坊闲谈</p></div>
        <figure className="xf-heroimage"><Portrait src={portraits.user} alt="掌柜在暖阳照进的木质饭馆里忙碌，使用原卡封面"/></figure>
      </section>
      <section className="xf-wrap xf-people" ref={family} tabIndex={-1} aria-labelledby="xf-family-title">
        <div className="xf-heading"><h2 className="xf-serif" id="xf-family-title">店里的人，就是家里的人。</h2><p className="xf-eyebrow">这一家子</p></div>
        <div className="xf-switcher" role="group" aria-label="选择要了解的人物">{people.map((p,index)=><button key={p.id} type="button" className="xf-personbutton" aria-pressed={selected===index} aria-controls="xf-person-panel" onClick={()=>setSelected(index)}>{p.name}</button>)}</div>
        <div className="xf-person" id="xf-person-panel"><figure className="xf-portrait" data-person={person.id}><Portrait key={person.id} src={person.image} alt={person.name+'的头像'}/></figure><div aria-live="polite" aria-atomic="true"><p className="xf-eyebrow">{person.role}</p><h3 className="xf-serif">{person.name}</h3><p className="xf-detail">{person.detail}</p><p className="xf-lead xf-serif">{person.first}</p><p className="xf-body">{person.body}</p><p className="xf-note">{person.note}</p></div></div>
      </section>
      <section className="xf-days" aria-labelledby="xf-days-title"><div className="xf-wrap"><p className="xf-eyebrow">小馆里的寻常事</p><h2 className="xf-serif" id="xf-days-title">今天，也有今天的滋味。</h2><div className="xf-daysgrid">
        <div className="xf-day"><span className="xf-number">壹 / 买菜</span><h3 className="xf-serif">去街上转一转</h3><p>挑一把新鲜青菜，问问草鱼的价钱。鸟儿知道哪家摊子实在，回来的路上，还能听见街坊的闲话。</p></div>
        <div className="xf-day"><span className="xf-number">贰 / 起灶</span><h3 className="xf-serif">让她们尝一口</h3><p>豆腐在锅里咕嘟，葱花切好放在手边。新菜端出来，听鱼儿说哪里还欠些火候，也听鸟儿直截了当的点评。</p></div>
        <div className="xf-day"><span className="xf-number">叁 / 过日子</span><h3 className="xf-serif">忙里也有闲时</h3><p>招呼熟客，记好流水，擦净桌椅。等店里清静下来，读几页书，喝一碗茶，再商量明天吃什么。</p></div>
      </div></div></section>
      <footer className="xf-wrap xf-foot"><p>大离的京城治安安稳，街市热闹。西域的香料与瓜果、东海来的海货，偶尔给餐桌添些新鲜；远方的江湖传闻，随着茶馆里的说书声飘过。</p><p className="xf-serif xf-close">门板卸下，水烧开。小馆又开始忙碌的一天。</p><div className="xf-bottom"><span>小饭馆 · 世界介绍</span><span>饭要趁热，日子慢慢来。</span></div></footer>
    </main>
  </article>;
}
