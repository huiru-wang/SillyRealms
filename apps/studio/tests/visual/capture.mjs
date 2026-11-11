/**
 * Minimal CDP visual smoke test using installed Google Chrome; no browser-test framework needed.
 * Start 'pnpm --filter @sillyrealms/studio dev' first.
 * Output screenshots are local and ignored by Git.
 */
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const base=process.env.STUDIO_URL || 'http://127.0.0.1:5174';
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
    '--hide-scrollbars','--remote-debugging-port=0','--force-device-scale-factor=1',
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

  await send('Page.enable');await send('Runtime.enable');await send('DOM.enable');await send('CSS.enable');
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
  for(const [label,path] of [['长安风云','/sessions/changan'],['通用叙事','/presets/general']]){
    await evaluate('([...document.querySelectorAll("aside button")].find(b=>b.textContent.includes('+JSON.stringify(label)+'))).click()');
    assert(await evaluate('location.pathname')===path,'Shortcut did not navigate to '+path);
    await click('a[aria-label="世界卡"]');
  }

  // No competing hover highlight when an item is already selected.
  const selectedNav='nav[aria-label="主导航"] a[aria-current="page"]';
  const selectedCategory='nav[aria-label="世界分类"] button:first-child';
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
  await click('button[aria-label="查看世界卡：长安风云"]');
  assert(await evaluate('!!document.querySelector("[role=dialog]")'),'World detail dialog not opened');
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until('!document.querySelector("[role=dialog]")');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reducedDuration=await evaluate('parseFloat(getComputedStyle(document.querySelector("[data-collapsed]")).transitionDuration)');
  assert(reducedDuration<0.001,'Reduced-motion preference must suppress layout motion');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'},{name:'hover',value:'hover'},{name:'pointer',value:'fine'}]});
  await viewport(1280,800);
  await navigate(base+'/worlds?sidebar=expanded&theme=dark');
  await screenshot('home-expanded-1280');
  await viewport(390,844,true);
  await navigate(base+'/worlds?sidebar=expanded&theme=dark');
  await screenshot('home-mobile-390');
  await click('[aria-label="打开导航"]');
  assert(await evaluate('document.querySelector("[aria-label=\\"关闭导航\\"]") !== null'),'Mobile menu missing');
  await screenshot('home-mobile-menu-390');
  // A collapsed desktop preference must never hide labels in the mobile drawer.
  await navigate(base+'/worlds?sidebar=collapsed&theme=dark');
  await click('[aria-label="打开导航"]');
  const mobileDataVisible=await evaluate('(()=>{const d=document.querySelector(\'aside section[aria-labelledby="sessions-heading"]\')?.parentElement;const t=document.querySelector(\'aside nav a span\');return !!d && !d.inert && getComputedStyle(d).visibility==="visible" && getComputedStyle(t).opacity==="1"})()');
  assert(mobileDataVisible,'Mobile drawer must reveal all labels even with collapsed desktop preference');
  assert(await evaluate(`document.querySelectorAll('a[aria-label="会话列表"]').length`)===1,'List links should not be duplicated');
  await click('#sessions-heading a');
  assert(await evaluate('location.pathname')==='/sessions','Mobile list heading did not navigate');
  assert(await evaluate(`document.querySelector('[aria-label="关闭导航遮罩"]').dataset.open`)==='false','Mobile drawer did not close after navigation');
  await click('[aria-label="打开导航"]');
  await click('[aria-label="关闭导航"]');
  assert(await evaluate('document.querySelector("[aria-label=\\"关闭导航遮罩\\"]").dataset.open')==='false','Mobile drawer did not close');
  assert(exceptionCount===0,'Browser JS exceptions: '+exceptionCount);
  console.log('PASS: stable sidebar material, intermediate animation width, selected hover, desktop expanded/collapsed, dialogs, theme, category, detail, mobile menu.');
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
