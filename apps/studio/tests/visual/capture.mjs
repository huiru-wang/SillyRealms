/**
 * Minimal CDP visual smoke test using installed Google Chrome; no browser-test framework needed.
 * Start 'pnpm --filter @sillyrealms/studio dev' first.
 * Output screenshots are local and ignored by Git.
 */
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {checkPresets} from './presets.mjs';

const base=process.env.STUDIO_URL || 'http://127.0.0.1:5174';
const presetsOnly=process.env.STUDIO_PRESETS_ONLY==='1';
const chromePath=process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out=resolve('tests/visual/output');
const profile=await mkdtemp(join(tmpdir(),'sr-studio-chrome-'));
const delay=(ms)=>new Promise(r=>setTimeout(r,ms));
let browser;
let conn;
let id=1;
const pend=new Map();
let exceptionCount=0;
try{
  await mkdir(out,{recursive:true});
  browser=spawn(chromePath,[
    '--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu',
    '--hide-scrollbars','--disable-smooth-scrolling','--remote-debugging-port=0','--force-device-scale-factor=1',
    '--window-size=1536,864','--user-data-dir='+profile,'about:blank'
  ],{stdio:'ignore'});
  let port;
  for(let i=0;i<70;i++){
    try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}
    catch{await delay(150);}
  }
  if(!port)throw new Error('Chrome CDP did not start');
  const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const page=pages.find(p=>p.type==='page');
  if(!page?.webSocketDebuggerUrl)throw new Error('Missing Chrome page');
  conn=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{conn.addEventListener('open',res,{once:true});conn.addEventListener('error',rej,{once:true});});
  conn.addEventListener('message',e=>{
    const data=JSON.parse(e.data);
    if(data.method==='Runtime.exceptionThrown')exceptionCount++;
    if(data.method==='DOM.documentUpdated')forcedHoverNodeId=null;
    if(data.id){
      const task=pend.get(data.id);if(!task)return;
      pend.delete(data.id);
      data.error?task.reject(new Error(JSON.stringify(data.error))):task.resolve(data.result);
    }
  });
  function send(method,params={}){
    const req=id++;
    return new Promise((resolve,reject)=>{
      pend.set(req,{resolve,reject});
      conn.send(JSON.stringify({id:req,method,params}));
    });
  }
  async function evaluate(expression){
    const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  }
  async function until(expression,timeout=10000){
    for(let elapsed=0;elapsed<timeout;elapsed+=150){
      if(await evaluate(expression))return;
      await delay(150);
    }
    throw new Error('Timeout: '+expression);
  }
  async function viewport(width,height,mobile=false){
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});
  }
  async function navigate(url){
    await send('Page.navigate',{url});
    await until("document.readyState === 'complete' && document.querySelectorAll('[aria-label^=\"查看世界卡\"]').length >= 1 && [...document.images].every(img=>img.complete)");
    await delay(420);
  }
  async function screenshot(name){
    const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(join(out,name+'.png'),Buffer.from(data,'base64'));
  }
  const click=async selector=>{
    const okay=await evaluate('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');if(!el)return false;el.click();return true})()');
    if(!okay)throw new Error('No element: '+selector);
    await delay(280);
  };
  let forcedHoverNodeId=null;
  async function hover(selector){
    if(forcedHoverNodeId){
      await send('CSS.forcePseudoState',{nodeId:forcedHoverNodeId,forcedPseudoClasses:[]});
    }
    const {root}=await send('DOM.getDocument',{depth:1});
    const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector});
    if(!nodeId)throw new Error('Missing selector for forced hover: '+selector);
    await send('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['hover']});
    forcedHoverNodeId=nodeId;
    await delay(180);
  }
  async function bg(selector){
    return evaluate('getComputedStyle(document.querySelector('+JSON.stringify(selector)+')).backgroundColor');
  }
  const assert=(condition,message)=>{if(!condition)throw new Error(message);};

  // Exercise the independent overview/workspace contract with real browser geometry and input.
  function worldMetrics() {
    return evaluate('('+function(){
      const main=document.getElementById('main-content');
      const overview=document.querySelector('[data-world-overview]');
      const viewport=document.querySelector('[data-world-viewport]');
      const workspace=document.querySelector('[data-world-workspace]');
      const content=document.querySelector('[data-world-content]');
      const rect=el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height}};
      const roles={};
      for(const kind of ['expanded','compact']){
        const strip=document.querySelector('[data-role-strip="'+kind+'"]');
        const buttons=[...strip.querySelectorAll('button')];
        const bounds=strip.getBoundingClientRect();
        const first=buttons.find(b=>{const r=b.getBoundingClientRect();return r.right>bounds.left+1 && r.left<bounds.right-1});
        let opacity=1;
        for(let node=strip;node;node=node.parentElement){
          const style=getComputedStyle(node);
          opacity*=Number(style.opacity);
          if(style.visibility==='hidden'||style.display==='none')opacity=0;
        }
        roles[kind]={names:buttons.map(b=>b.title),selected:buttons.find(b=>b.getAttribute('aria-pressed')==='true')?.title,anchor:first?.title,opacity,inert:!!strip.closest('[inert]'),scrollLeft:strip.scrollLeft,maxScroll:strip.scrollWidth-strip.clientWidth};
      }
      return {
        outerTop:main.scrollTop,range:main.scrollHeight-main.clientHeight,outerHeight:main.clientHeight,
        progress:Number(document.querySelector('[data-collapse-progress]').dataset.collapseProgress),
        overview:rect(overview),viewport:rect(viewport),workspace:rect(workspace),content:rect(content),
        contentTop:content.scrollTop,contentRange:content.scrollHeight-content.clientHeight,
        nav:[...document.querySelectorAll('nav[aria-label="世界详情章节"] button')].map(rect),
        pageTop:document.scrollingElement.scrollTop,pageWidth:document.documentElement.scrollWidth,windowWidth:innerWidth,roles
      };
    }.toString()+')()');
  }

  async function setWorldProgress(progress) {
    await evaluate('(()=>{const main=document.getElementById("main-content");main.scrollTo({top:(main.scrollHeight-main.clientHeight)*'+progress+',behavior:"instant"})})()');
    await until('Math.abs(Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)-'+progress+')<0.025');
    await delay(80);
  }

  async function worldWheel(deltaY) {
    const {content}=await worldMetrics();
    const point={x:(content.left+content.right)/2,y:Math.min(content.bottom-20,content.top+Math.max(35,content.height/2))};
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY});
    await delay(320);
  }

  async function openWorldDetail() {
    await click('button[aria-label="查看世界卡：长安风云"]');
    await until('location.pathname==="/worlds/changan" && !!document.querySelector("[data-world-content]") && [...document.images].every(img=>img.complete)');
    await delay(120);
    const overviewClean=await evaluate('('+function(){
      const overview=document.querySelector('[data-world-overview]');
      const page=document.querySelector('[data-collapse-progress]');
      return ![...overview.querySelectorAll('h2')].some(heading=>heading.textContent.trim()==='世界角色')
        && !overview.textContent.includes('选择角色，探索不同的故事视角')
        && !page.querySelector('a[href="/worlds"],[aria-label="返回世界卡列表"]')
        && !!document.querySelector('aside a[aria-label="世界卡"][href="/worlds"]');
    }.toString()+')()');
    assert(overviewClean,'World detail should omit the role hint and page back button while retaining sidebar navigation');
  }

  async function checkOverviewWheel() {
    await setWorldProgress(0);
    const dispatch=async(point,deltaY)=>{
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY});
      await delay(320);
    };
    let before=await worldMetrics();
    await dispatch({x:before.overview.right-15,y:before.overview.top+90},85);
    let after=await worldMetrics();
    assert(after.outerTop>before.outerTop+20 && after.overview.height<before.overview.height-20 && after.workspace.top<before.workspace.top-20,'A-area wheel must collapse A and raise B');
    assert(after.contentTop===before.contentTop,'A-area wheel must not scroll detail content');
    before=after;
    const section=before.nav[0];
    await dispatch({x:(section.left+section.right)/2,y:(section.top+section.bottom)/2},65);
    after=await worldMetrics();
    assert(after.outerTop>before.outerTop+15 && after.overview.height<before.overview.height-15,'Left-navigation wheel must reach the outer overview scroll');
    assert(after.contentTop===before.contentTop,'Left-navigation wheel must not scroll detail content');
    before=after;
    await dispatch({x:before.overview.right-15,y:before.overview.top+65},-90);
    after=await worldMetrics();
    assert(after.outerTop<before.outerTop-20 && after.overview.height>before.overview.height+20,'Reverse wheel over A must restore the overview');
    await setWorldProgress(1);
    console.log('PASS: real wheel over A and left navigation drives the outer collapse and restores A.');
  }

  async function checkCompactLongTitle() {
    const original=await evaluate('document.querySelector("[data-world-overview] h1").textContent');
    try{
      await evaluate('document.querySelector("[data-world-overview] h1").textContent="长安风云：繁华与隐秘交织的千年古城，十位人物共同书写的命运长卷"');
      const layout=await evaluate('('+function(){
        const title=document.querySelector('[data-world-overview] h1');
        const roles=document.querySelector('[data-role-strip="compact"]');
        const text=title.getBoundingClientRect(),strip=roles.getBoundingClientRect();
        const hit=document.elementFromPoint(text.right-4,text.top+text.height/2);
        return {
          gap:strip.left-text.right,
          clipped:title.scrollWidth>title.clientWidth,
          ellipsis:getComputedStyle(title).textOverflow,
          titleHit:hit===title||title.contains(hit)
        };
      }.toString()+')()');
      assert(layout.clipped && layout.ellipsis==='ellipsis','Long compact title should truncate within its allocated width');
      assert(layout.gap>=8,'Long compact title overlaps or crowds the role list: gap='+layout.gap);
      assert(layout.titleHit,'Compact title must remain hit-testable for text selection and its full-title tooltip');
      await screenshot('world-detail-long-title-1280');
    }finally{
      await evaluate('document.querySelector("[data-world-overview] h1").textContent='+JSON.stringify(original));
    }
    console.log('PASS: 1280 compact long title remains separated, truncated, and hit-testable.');
  }

  async function checkWorldGeometry(label,shots) {
    await setWorldProgress(0);
    const expanded=await worldMetrics();
    const ratio=expanded.overview.height/expanded.outerHeight;
    assert(ratio>=0.27&&ratio<=0.46,label+': overview should occupy about one third of the viewport; got '+ratio.toFixed(3));
    assert(expanded.nav.length===5 && expanded.nav.every(r=>r.top>=expanded.workspace.top-1 && r.bottom<=expanded.viewport.bottom+1),label+': all five sections must be visible on entry');
    assert(expanded.roles.expanded.names.length===20 && JSON.stringify(expanded.roles.expanded.names)===JSON.stringify(expanded.roles.compact.names),label+': both role lists must retain all 20 长安风云 characters');
    assert(expanded.roles.expanded.opacity>0.99 && expanded.roles.compact.opacity<0.01 && expanded.roles.compact.inert,label+': compact roles must initially be invisible and inert');
    assert(expanded.range>40,label+': outer scroll should have a bounded collapse range');
    await screenshot(shots[0]);
    const samples=[expanded];
    for(const progress of [0.25,0.5,0.75,1]){
      await setWorldProgress(progress);
      const current=await worldMetrics();
      const previous=samples.at(-1);
      assert(current.overview.height<previous.overview.height-1,label+': A height did not shrink continuously');
      assert(current.workspace.top<previous.workspace.top-1,label+': B did not move upward with A');
      assert(Math.abs((expanded.overview.height-current.overview.height)-(expanded.workspace.top-current.workspace.top))<2,label+': B displacement must equal the released A height');
      assert(Math.abs(current.overview.top-expanded.overview.top)<2,label+': A should remain attached to the top');
      assert(Math.abs(current.workspace.bottom-expanded.workspace.bottom)<2,label+': B should fill the remaining viewport');
      assert(Math.abs(current.range-expanded.range)<2,label+': shrinking A changed the outer scroll range');
      assert(current.content.bottom<=current.viewport.bottom+2 && current.workspace.top>=current.overview.bottom-2,label+': content escaped its workspace');
      assert(current.roles.expanded.opacity<0.01 || current.roles.compact.opacity<0.01,label+': lower roles must fade out before compact roles appear');
      assert(current.pageTop===0 && current.pageWidth<=current.windowWidth+1,label+': detail should not create document scrolling');
      samples.push(current);
      if(progress===0.5)await screenshot(shots[1]);
    }
    const compact=samples.at(-1);
    assert(compact.roles.compact.opacity>0.99 && compact.roles.expanded.opacity<0.01 && compact.roles.expanded.inert,label+': compact state must expose only the upper role list');
    assert(compact.roles.compact.selected===compact.roles.expanded.selected,label+': selected role changed during collapse');
    await screenshot(shots[2]);
    console.log('World layout '+label+':',JSON.stringify(samples.map(s=>({scroll:Math.round(s.outerTop),a:Math.round(s.overview.height),bTop:Math.round(s.workspace.top),bHeight:Math.round(s.workspace.height)}))));
  }

  async function checkDetailScrollIsolation(label) {
    await setWorldProgress(0);
    await evaluate('document.querySelector("[data-world-content]").scrollTop=0');
    let before=await worldMetrics();
    assert(before.contentRange>30,label+': introduction fixture must exercise real content scrolling');
    await worldWheel(180);
    let after=await worldMetrics();
    assert(after.contentTop>20,label+': wheel over detail did not scroll its content');
    assert(Math.abs(after.outerTop-before.outerTop)<1 && Math.abs(after.overview.height-before.overview.height)<1,label+': detail scrolling collapsed the overview');
    await setWorldProgress(0.4);
    for(const edge of ['top','bottom']){
      await evaluate('(()=>{const content=document.querySelector("[data-world-content]");content.scrollTop='+(edge==='top'?'0':'content.scrollHeight')+'})()');
      await delay(100);
      before=await worldMetrics();
      await worldWheel(edge==='top'?-650:650);
      after=await worldMetrics();
      assert(Math.abs(after.outerTop-before.outerTop)<1 && Math.abs(after.workspace.top-before.workspace.top)<1,label+': '+edge+' detail boundary leaked wheel scrolling into the outer page');
      assert(Math.abs(after.contentTop-before.contentTop)<1,label+': content did not remain at its '+edge+' boundary');
    }
    await evaluate('(()=>{const content=document.querySelector("[data-world-content]");content.scrollTop=0;content.focus({preventScroll:true})})()');
    assert(await evaluate('document.activeElement===document.querySelector("[data-world-content]")'),label+': detail must be keyboard focusable');
    before=await worldMetrics();
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'PageDown',code:'PageDown',windowsVirtualKeyCode:34,nativeVirtualKeyCode:34});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'PageDown',code:'PageDown',windowsVirtualKeyCode:34,nativeVirtualKeyCode:34});
    await delay(350);
    after=await worldMetrics();
    assert(after.contentTop>10 && Math.abs(after.outerTop-before.outerTop)<1,label+': PageDown should scroll the focused detail only');
    console.log('PASS: '+label+' detail wheel, both boundaries, and keyboard isolation.');
  }

  async function checkShortDetailIsolation() {
    await click('nav[aria-label="世界详情章节"] button:nth-child(5)');
    await until('document.querySelector("[data-world-content] h2")?.textContent==="运行配置" && Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)>0.99');
    await setWorldProgress(0.4);
    const before=await worldMetrics();
    assert(before.contentRange<=1,'Runtime fixture should fit without overflow, so short-content wheel isolation is actually exercised');
    for(const delta of [-650,650]){
      await worldWheel(delta);
      const after=await worldMetrics();
      assert(Math.abs(after.outerTop-before.outerTop)<1 && after.contentTop===0,'A non-overflowing detail pane leaked wheel scrolling into the outer page');
    }
    // Clicking the already-selected section must still bring the workspace into reading mode.
    await click('nav[aria-label="世界详情章节"] button:nth-child(5)');
    await until('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)>0.99');
    assert((await worldMetrics()).contentTop===0,'Section click should reset only the detail content to its start');
    console.log('PASS: short-content wheel isolation and repeated section activation.');
  }

  async function checkLastRoleBrowsing(label) {
    const inspect=kind=>evaluate('('+function(kind){
      const strip=document.querySelector('[data-role-strip="'+kind+'"]');
      const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
      const buttons=[...strip.querySelectorAll('button')];
      return {bounds:rect(strip),first:rect(buttons[0]),last:rect(buttons.at(-1)),lastName:buttons.at(-1).title,count:buttons.length,left:strip.scrollLeft,max:strip.scrollWidth-strip.clientWidth,width:strip.scrollWidth};
    }.toString()+')('+JSON.stringify(kind)+')');
    const wheel=async(info,deltaX)=>{
      const point={x:(info.bounds.left+info.bounds.right)/2,y:(info.bounds.top+info.bounds.bottom)/2};
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX,deltaY:0});
      await delay(240);
    };
    const press=async(bounds)=>{
      const point={x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2};
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
      await delay(100);
    };
    for(const [kind,progress] of [['expanded',0],['compact',1]]){
      await setWorldProgress(progress);
      const before=await worldMetrics();
      let strip=await inspect(kind);
      assert(strip.count===20 && strip.max>100,label+': '+kind+' must exercise an overflowing 20-character list');
      await wheel(strip,-strip.width);
      await until('document.querySelector(\'[data-role-strip="'+kind+'"]\').scrollLeft<2');
      strip=await inspect(kind);
      assert(strip.left<2,label+': '+kind+' horizontal wheel could not reach the first character');
      await press(strip.first);
      const firstSelection=(await worldMetrics()).roles[kind];
      assert(firstSelection.selected===firstSelection.names[0],label+': '+kind+' first character could not be selected by pointer input');
      await wheel(strip,strip.width);
      await until('(()=>{const strip=document.querySelector(\'[data-role-strip="'+kind+'"]\');return Math.abs(strip.scrollLeft-(strip.scrollWidth-strip.clientWidth))<2})()');
      strip=await inspect(kind);
      assert(Math.abs(strip.left-strip.max)<2 && strip.last.left>=strip.bounds.left-1 && strip.last.right<=strip.bounds.right+1,label+': '+kind+' horizontal wheel could not fully reveal the last character');
      await press(strip.last);
      const after=await worldMetrics();
      assert(after.roles.expanded.selected===strip.lastName && after.roles.compact.selected===strip.lastName,label+': choosing the last '+kind+' character did not synchronize both role lists');
      assert(Math.abs(after.outerTop-before.outerTop)<1 && Math.abs(after.overview.height-before.overview.height)<1 && Math.abs(after.workspace.top-before.workspace.top)<1 && Math.abs(after.workspace.height-before.workspace.height)<1 && Math.abs(after.contentTop-before.contentTop)<1,label+': '+kind+' horizontal browsing moved A/B or the detail content');
      await screenshot('world-detail-'+kind+'-last-role-'+label);
    }
    console.log('PASS: '+label+' real horizontal browsing reaches and selects character 20 in both densities without moving A/B.');
  }

  async function checkOtherWorldRoleCount() {
    const label=await evaluate('([...document.querySelectorAll(\'button[aria-label^="查看世界卡："]\')].find(button=>button.getAttribute("aria-label")!=="查看世界卡：长安风云"))?.getAttribute("aria-label")');
    assert(label,'Need one other world fixture to verify the character expansion is scoped');
    await click('button[aria-label='+JSON.stringify(label)+']');
    await until('location.pathname.startsWith("/worlds/") && location.pathname!=="/worlds/changan" && !!document.querySelector("[data-role-strip]")');
    const counts=await evaluate('["expanded","compact"].map(kind=>document.querySelectorAll(\'[data-role-strip="\'+kind+\'"] button\').length)');
    assert(counts.every(count=>count===10),'Only 长安风云 should have 20 characters; another world unexpectedly changed: '+counts.join('/'));
    await click('aside a[aria-label="世界卡"]');
    console.log('PASS: another world keeps its original 10 characters and sidebar navigation returns to the library.');
  }

  async function checkRoleAnchor(label) {
    await setWorldProgress(0);
    await evaluate('('+function(){
      const strip=document.querySelector('[data-role-strip="expanded"]');
      const button=strip.querySelectorAll('button')[2];
      strip.scrollLeft+=button.getBoundingClientRect().left-strip.getBoundingClientRect().left+2;
    }.toString()+')()');
    await delay(150);
    const before=await worldMetrics();
    assert(before.roles.expanded.scrollLeft>40 && before.roles.expanded.anchor!==before.roles.expanded.names[0],label+': role anchor check must begin away from the first character');
    await setWorldProgress(1);
    const compact=await worldMetrics();
    assert(compact.roles.compact.anchor===before.roles.expanded.anchor,label+': compact list lost the first visible character ('+before.roles.expanded.anchor+' → '+compact.roles.compact.anchor+')');
    await click('[data-role-strip="compact"] button:nth-child(4)');
    const selected=(await worldMetrics()).roles;
    assert(selected.compact.selected===selected.compact.names[3] && selected.expanded.selected===selected.compact.selected,label+': role selection did not synchronize');
    await setWorldProgress(0);
    const restored=await worldMetrics();
    assert(restored.roles.expanded.anchor===compact.roles.compact.anchor,label+': expanded list lost its browsing anchor after restoring');
    assert(restored.roles.expanded.selected===selected.compact.selected,label+': selected character changed when restoring the overview');
    console.log('PASS: '+label+' complete role lists, selection, and horizontal browsing anchor.');
  }

  async function checkWorldReducedMotion() {
    await openWorldDetail();
    await setWorldProgress(0);
    const position=await evaluate('('+async function(){
      document.querySelector('nav[aria-label="世界详情章节"] button:nth-child(3)').click();
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const main=document.getElementById('main-content');
      return {actual:main.scrollTop,target:main.scrollHeight-main.clientHeight};
    }.toString()+')()');
    assert(Math.abs(position.actual-position.target)<2,'Reduced motion should reach the compact workspace immediately on section activation');
    assert(await evaluate('document.querySelector("[data-world-content] h2")?.textContent')==='世界状态','Reduced-motion section activation failed');
    await screenshot('world-detail-reduced-motion-1536');
    await click('a[aria-label="世界卡"]');
  }

  await send('Page.enable');await send('Runtime.enable');await send('DOM.enable');await send('CSS.enable');
  if(!presetsOnly){
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'},{name:'hover',value:'hover'},{name:'pointer',value:'fine'}]});
  await viewport(1536,864);
  await navigate(base+'/worlds?sidebar=expanded&theme=dark');
  assert(await evaluate('document.querySelectorAll("[aria-label^=\\"查看世界卡\\"]").length')===8,'Expected 8 cards');
  assert(await evaluate(`document.querySelectorAll('nav[aria-label="主导航"] a').length`)===1,'Primary navigation should contain only worlds');
  assert(await evaluate(`document.querySelector('aside section img')?.clientWidth`)===44,'Session thumbnail should be 44px');
  const primaryStyles=await evaluate(`['世界卡','会话列表','预设列表'].map(label=>{const el=document.querySelector('a[aria-label="'+label+'"]');const s=getComputedStyle(el);return [s.fontSize,s.fontWeight,s.color,!!el.querySelector('svg')]})`);
  assert(primaryStyles.every(style=>JSON.stringify(style.slice(0,2))===JSON.stringify(primaryStyles[0].slice(0,2))&&style[3]),'Primary links should share typography and icons');
  const sidebarEdges=await evaluate(`(()=>{const selectors=['nav[aria-label="主导航"] a','#sessions-heading a','aside section button','#presets-heading a'];return selectors.map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.left,r.right]})})()`);
  assert(sidebarEdges.every(([left,right])=>Math.abs(left-sidebarEdges[0][0])<1&&Math.abs(right-sidebarEdges[0][1])<1),'Sidebar row edges should align: '+JSON.stringify(sidebarEdges));
  await screenshot('home-expanded-1536');
  for(const [selector,path] of [['#sessions-heading a','/sessions'],['#presets-heading a','/presets'],['a[aria-label="模型"]','/models']]){
    await click(selector);
    assert(await evaluate('location.pathname')===path,'Incorrect destination for '+selector);
    assert(await evaluate('document.querySelector('+JSON.stringify(selector)+')?.getAttribute("aria-current")')==='page','Missing selected state for '+selector);
    await click('a[aria-label="世界卡"]');
  }
  await evaluate('([...document.querySelectorAll("aside button")].find(b=>b.textContent.includes("长安风云"))).click()');
  assert(await evaluate('location.pathname')==='/sessions/changan','Session shortcut did not navigate to its session');
  await click('a[aria-label="世界卡"]');
  const presetShortcuts=await evaluate('[...document.querySelectorAll("aside [data-preset-shortcut]")].map(link=>({id:link.dataset.presetShortcut,href:link.getAttribute("href")}))');
  assert(presetShortcuts.length>0&&presetShortcuts.every(link=>link.href?.startsWith("/presets/")),'Preset shortcuts require real links to available presets');
  for(const shortcut of presetShortcuts){
    await click('aside [data-preset-shortcut='+JSON.stringify(shortcut.id)+']');
    assert(await evaluate('location.pathname')===new URL(shortcut.href,base).pathname,'Preset shortcut did not follow its href: '+shortcut.href);
    assert(await evaluate('!!document.querySelector("[data-preset-workspace]")'),'Preset shortcut should open the preset workbench');
    await click('a[aria-label="世界卡"]');
  }

  // No competing hover highlight when an item is already selected.
  const selectedNav='nav[aria-label="主导航"] a[aria-current="page"]';
  const selectedCategory='nav[aria-label="世界分类"] button:first-child';
  await delay(350);
  const navBackground=await bg(selectedNav);
  await hover(selectedNav);
  assert(await bg(selectedNav)===navBackground,'Selected nav changes background on hover');
  const categoryBackground=await bg(selectedCategory);
  await hover(selectedCategory);
  assert(await bg(selectedCategory)===categoryBackground,'Selected category changes background on hover');
  const unselectedNav='a[aria-label="模型"]';
  await hover(unselectedNav);
  // Headless CDP can report :hover without repainting the transitioned background.
  // Verify the unselected-only rule exists, not a timing-sensitive interpolated pixel.
  const hasNonSelectedHoverRule=await evaluate('([...document.styleSheets].some(s=>[...s.cssRules].some(r=>r.cssText.includes(":not(") && r.cssText.includes(":hover") && r.cssText.includes("navItem"))))');
  assert(hasNonSelectedHoverRule,'Missing unselected navigation hover rule');

  // The same floating sidebar must smoothly interpolate its track, not snap to a dock.
  const trackExpr='document.querySelector("aside").getBoundingClientRect().width';
  const initialWidth=await evaluate(trackExpr);
  const layoutTransition=await evaluate('(()=>{const s=getComputedStyle(document.querySelector("[data-collapsed]"));return {duration:parseFloat(s.transitionDuration),property:s.transitionProperty}})()');
  assert(layoutTransition.property==='grid-template-columns' && layoutTransition.duration>=0.25,'Missing layout transition');
  const sidebarBefore=await evaluate('(()=>{const s=getComputedStyle(document.querySelector("aside > div"));return {r:s.borderRadius,b:s.backgroundColor}})()');
  const startCollapse=await evaluate('(()=>{const b=document.querySelector(\'[aria-label="收起侧边栏"]\');b?.click();return !!b})()');
  assert(startCollapse,'Collapse control missing');
  await until('document.querySelector("[data-collapsed]").dataset.collapsed==="true"');
  const transition=await evaluate('(()=>{const a=document.getAnimations().find(a=>a.transitionProperty==="grid-template-columns");return a?{duration:a.effect.getTiming().duration,playState:a.playState,currentTime:a.currentTime}:null})()');
  assert(transition && transition.duration>=250,'Grid transition not created');
  const widths=await evaluate('(()=>{const a=document.getAnimations().find(a=>a.transitionProperty==="grid-template-columns");if(!a)return null;a.pause();const out=[];for(const ms of [40,95,160]){a.currentTime=ms;out.push(document.querySelector("aside").getBoundingClientRect().width)}a.currentTime=95;return out})()');
  if(widths)await screenshot('home-transition-mid-1536');
  await evaluate('document.getAnimations().filter(a=>a.transitionProperty==="grid-template-columns").forEach(a=>a.finish())');
  await delay(50);
  const widthEnd=await evaluate(trackExpr);
  assert(widths!==null && widths[0]<initialWidth-10 && widths[0]>widths[1] && widths[1]>widths[2] && widths[2]>widthEnd,
    'Sidebar width did not interpolate monotonically: '+[initialWidth,...(widths||[]),widthEnd].join(', '));
  assert(Math.abs(widthEnd-92)<3,'Collapsed track expected ~92px, got '+widthEnd);
  const sidebarAfter=await evaluate('(()=>{const s=getComputedStyle(document.querySelector("aside > div"));return {r:s.borderRadius,b:s.backgroundColor}})()');
  assert(JSON.stringify(sidebarBefore)===JSON.stringify(sidebarAfter),'Sidebar changes shape/material between states');
  assert(await evaluate('!!document.querySelector("aside [aria-hidden=true][inert]")'),
    'Collapsed sidebar data should be inert');
  await delay(350);
  await screenshot('home-collapsed-1536');
  for(const [label,path] of [['会话列表','/sessions'],['预设列表','/presets'],['模型','/models']]){
    const selector='a[aria-label="'+label+'"]';
    await click(selector);
    assert(await evaluate('location.pathname')===path,'Collapsed link did not navigate to '+path);
    assert(await evaluate('document.querySelector('+JSON.stringify(selector)+')?.getAttribute("aria-current")')==='page','Collapsed link missing selected state');
    await click('a[aria-label="世界卡"]');
  }
  await click('[aria-label="展开侧边栏"]');
  assert(await evaluate('document.querySelector("[data-collapsed]").dataset.collapsed')==='false','Sidebar did not expand');
  await delay(380);
  assert(Math.abs((await evaluate(trackExpr))-initialWidth)<3,'Sidebar expansion did not restore width');
  await click('button[aria-label="设置"]');
  assert(await evaluate('!!document.querySelector("[role=dialog]")'),'Settings dialog not opened');
  assert(await evaluate('document.getElementById("root").inert'),'Dialog should make background inert');
  await evaluate(`(()=>{const b=document.querySelector('[role=dialog] button[aria-label="关闭弹窗"]');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))})()`);
  assert(await evaluate(`document.activeElement===Array.from(document.querySelectorAll('[role=dialog] button')).at(-1)`),'Shift+Tab should wrap inside dialog');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until('!document.querySelector("[role=dialog]")');
  assert(await evaluate('!document.getElementById("root").inert'),'Dialog should restore background');
  await click('button[aria-label="切换亮色主题"]');
  assert(await evaluate('document.documentElement.dataset.theme')==='light','Theme did not switch');
  await click('button[aria-label="切换暗色主题"]');
  await click('nav[aria-label="世界分类"] button:nth-child(3)');
  assert(await evaluate('document.querySelectorAll("[aria-label^=\\"查看世界卡\\"]").length')===2,'Filtering failed');
  await click('nav[aria-label="世界分类"] button:nth-child(1)');
  await openWorldDetail();
  await checkWorldGeometry('1536',[
    'world-detail-expanded-1536','world-detail-transition-1536','world-detail-compact-1536'
  ]);
  await checkOverviewWheel();
  await checkLastRoleBrowsing('1536');
  await click('[data-role-strip="compact"] button:nth-child(5)');
  assert(await evaluate(`document.querySelector('[data-role-strip="expanded"] button:nth-child(5)').getAttribute("aria-pressed")`)==='true','Role selected state not synced');
  await checkDetailScrollIsolation('1536');
  await click('nav[aria-label="世界详情章节"] button:nth-child(2)');
  await until('document.querySelector("[data-world-content] h2")?.textContent==="世界书" && Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)>0.99');
  assert((await worldMetrics()).contentTop===0,'Switching sections should reset detail scroll position');
  await checkShortDetailIsolation();
  await click('a[aria-label="世界卡"]');
  await checkOtherWorldRoleCount();
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reducedDuration=await evaluate('parseFloat(getComputedStyle(document.querySelector("[data-collapsed]")).transitionDuration)');
  assert(reducedDuration<0.001,'Reduced-motion preference must suppress layout motion');
  await checkWorldReducedMotion();
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'},{name:'hover',value:'hover'},{name:'pointer',value:'fine'}]});
  await viewport(1280,800);
  await navigate(base+'/worlds?sidebar=expanded&theme=dark');
  await screenshot('home-expanded-1280');
  await openWorldDetail();
  await checkWorldGeometry('1280',[
    'world-detail-expanded-1280','world-detail-transition-1280','world-detail-compact-1280'
  ]);
  await checkCompactLongTitle();
  await click('a[aria-label="世界卡"]');
  await viewport(768,1024);
  await navigate(base+'/worlds?sidebar=expanded&theme=dark');
  await openWorldDetail();
  await checkWorldGeometry('768',[
    'world-detail-tablet-768','world-detail-tablet-transition-768','world-detail-tablet-compact-768'
  ]);
  await click('a[aria-label="世界卡"]');
  await viewport(390,844,true);
  await navigate(base+'/worlds?sidebar=expanded&theme=dark');
  await screenshot('home-mobile-390');
  await openWorldDetail();
  await checkWorldGeometry('390',[
    'world-detail-mobile-390','world-detail-mobile-transition-390','world-detail-mobile-compact-390'
  ]);
  await checkLastRoleBrowsing('390');
  await checkRoleAnchor('390');
  await click('a[aria-label="世界卡"]');
  await click('[aria-label="打开导航"]');
  assert(await evaluate('document.querySelector("[aria-label=\\"关闭导航\\"]") !== null'),'Mobile menu missing');
  await screenshot('home-mobile-menu-390');
  // A collapsed desktop preference must never hide labels in the mobile drawer.
  await navigate(base+'/worlds?sidebar=collapsed&theme=dark');
  await click('[aria-label="打开导航"]');
  await delay(350);
  const mobileDataVisible=await evaluate('(()=>{const d=document.querySelector(\'aside section[aria-labelledby="sessions-heading"]\')?.parentElement;const t=document.querySelector(\'aside nav a span\');return !!d && !d.inert && getComputedStyle(d).visibility==="visible" && getComputedStyle(t).opacity==="1"})()');
  assert(mobileDataVisible,'Mobile drawer must reveal all labels even with collapsed desktop preference');
  assert(await evaluate(`document.querySelectorAll('a[aria-label="会话列表"]').length`)===1,'List links should not be duplicated');
  await click('#sessions-heading a');
  assert(await evaluate('location.pathname')==='/sessions','Mobile list heading did not navigate');
  assert(await evaluate(`document.querySelector('[aria-label="关闭导航遮罩"]').dataset.open`)==='false','Mobile drawer did not close after navigation');
  await click('[aria-label="打开导航"]');
  await click('[aria-label="关闭导航"]');
  assert(await evaluate('document.querySelector("[aria-label=\\"关闭导航遮罩\\"]").dataset.open')==='false','Mobile drawer did not close');
  await viewport(375,812,true);
  await navigate(base+'/worlds?sidebar=expanded&theme=dark');
  await openWorldDetail();
  await checkWorldGeometry('375',[
    'world-detail-mobile-375','world-detail-mobile-transition-375','world-detail-mobile-compact-375'
  ]);
  await checkRoleAnchor('375');
  }
  await checkPresets({send,evaluate,until,viewport,click,screenshot,delay,assert,base,hover,bg});
  assert(exceptionCount===0,'Browser JS exceptions: '+exceptionCount);
  if(!presetsOnly)console.log('PASS: stable sidebar material, intermediate animation width, selected hover, desktop expanded/collapsed, dialogs, theme, category, independent A/B scrolling, 20-character browsing and role anchors, preset workbench/editing/dragging, reduced motion, and 375/390/768/1280/1536 layouts.');
  console.log('Screenshots:',out);
}catch(e){
  console.error('FAIL:',e);
  process.exitCode=1;
}finally{
  if(conn?.readyState===WebSocket.OPEN)conn.close();
  if(browser)browser.kill();
  await delay(250);
  await rm(profile,{recursive:true,force:true}).catch(()=>{});
}
