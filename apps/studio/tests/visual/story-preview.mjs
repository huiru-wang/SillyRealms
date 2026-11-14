/** Integration checks exercise the production SDK inside Studio's opaque-origin iframe. */
export async function createPreviewDriver({send,evaluate,delay}){
  let iframeUrl,nonce,sessionId,contextId,lastTargets,lastTree;
  const matches=url=>url.includes('/preview-frame.html')&&!!nonce&&url.includes(nonce);
  const find=tree=>{
    if(matches(tree.frame.url))return tree.frame;
    for(const child of tree.childFrames??[]){const result=find(child);if(result)return result;}
  };
  for(let i=0;i<100&&!sessionId&&!contextId;i++){
    iframeUrl=await evaluate('document.querySelector("iframe[data-story-preview]")?.getAttribute("src")');
    nonce=iframeUrl?new URL(iframeUrl,'http://preview.invalid').hash.slice(1):'';
    if(!nonce){await delay(100);continue;}
    const targets=await send('Target.getTargets');
    lastTargets=targets.targetInfos.map(t=>({type:t.type,url:t.url}));
    const target=targets.targetInfos.find(t=>t.type==='iframe'&&matches(t.url));
    if(target){
      sessionId=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
      await send('Runtime.enable',{},sessionId);
    }else{
      lastTree=(await send('Page.getFrameTree')).frameTree;
      const frame=find(lastTree);
      if(frame)contextId=(await send('Page.createIsolatedWorld',{frameId:frame.id,worldName:'sr-studio-regression'})).executionContextId;
    }
    if(!sessionId&&!contextId)await delay(100);
  }
  if(!sessionId&&!contextId)throw Error('Could not attach to the sandboxed preview: '+JSON.stringify({iframeUrl,lastTargets,lastTree,host:await evaluate('document.querySelector("[data-session-detail]")?.innerText')}));
  const frameEval=async expression=>{
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...(contextId?{contextId}:{})},sessionId);
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
    return result.result.value;
  };
  const wait=async(expression,timeout=10000)=>{
    for(let elapsed=0;elapsed<timeout;elapsed+=100){
      if(await frameEval(expression))return;
      await delay(100);
    }
    throw Error('Preview timeout: '+expression+'; '+(await frameEval('document.body.innerText')).slice(0,1800));
  };
  const click=async selector=>{
    const found=await frameEval('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)return false;e.focus();e.click();return true})()');
    if(!found)throw Error('Missing preview control: '+selector);
    await delay(100);
  };
  const prepareImage=()=>send('Fetch.enable',{patterns:[{urlPattern:'https://sr-preview.invalid/deferred.svg'}]},sessionId);
  return {evaluate:frameEval,until:wait,click,prepareImage};
}

export async function replacePreviewDraft({send,evaluate,delay},text){
  await evaluate('(()=>{const e=document.querySelector(".sr-composer-editor");e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r)})()');
  await send('Input.insertText',{text});
  await delay(100);
}

export async function checkStoryPreview(ctx){
  const {send,evaluate,until,viewport,click,screenshot,delay,assert,open}=ctx;
  let frame;
  const load=async(scenario='',name='changan')=>{
    await open('/sessions/'+name,scenario);
    frame=await createPreviewDriver(ctx);
    await frame.until('!!document.querySelector(".sr-story")');
    return frame;
  };
  const draft=text=>replacePreviewDraft(ctx,text);
  const sendDraft=async text=>{
    await until('document.querySelector("[data-session-detail]")?.dataset.previewReady==="true"');
    await draft(text);
    await evaluate('(()=>{const e=document.querySelector("[data-session-detail]");window.__previewPhaseObserver?.disconnect();window.__previewPhases=[];const record=()=>{const p=e.dataset.previewPhase;if(window.__previewPhases.at(-1)!==p)window.__previewPhases.push(p)};record();window.__previewPhaseObserver=new MutationObserver(record);window.__previewPhaseObserver.observe(e,{attributes:true,attributeFilter:["data-preview-phase"]})})()');
    await click('[aria-label="发送消息到本地预览"]');
  };
  const finish=async()=>{
    await until('document.querySelector("[data-session-detail]")?.dataset.previewActive==="false"');
    await delay(160);
  };
  const anchor=async()=>frame.evaluate('(()=>{const c=document.querySelector(".sr-chat-messages"),top=c.getBoundingClientRect().top;const m=[...c.querySelectorAll("[data-message-id]")].find(n=>n.getBoundingClientRect().bottom>top);return {id:m.dataset.messageId,top:m.getBoundingClientRect().top-top}})()');
  const assertAnchor=async(before,label)=>{
    const after=await frame.evaluate('(()=>{const c=document.querySelector(".sr-chat-messages"),m=[...c.querySelectorAll("[data-message-id]")].find(n=>n.dataset.messageId==='+JSON.stringify(before.id)+');return {id:m?.dataset.messageId,top:m?.getBoundingClientRect().top-c.getBoundingClientRect().top}})()');
    assert(after.id===before.id&&Math.abs(after.top-before.top)<=2,label+': '+JSON.stringify({before,after}));
  };
  await viewport(1536,900,false);
  await load();
  await frame.until('document.querySelectorAll(".sr-message").length===10 && document.querySelectorAll(".sr-suggestions button").length===3');
  assert(await evaluate('document.querySelector("iframe[data-story-preview]").getAttribute("sandbox")')==='allow-scripts','Preview must retain an opaque origin');
  assert(await frame.evaluate('(()=>{try{return !!parent.document}catch{return false}})()')===false,'Preview cannot read the Host document');
  assert(await frame.evaluate('fetch("/api/worlds").then(()=>false,()=>true)'),'Frame CSP must reject direct API requests');
  const style=await frame.evaluate('(()=>{const m=[...document.querySelectorAll(".sr-message")],u=document.querySelector(".sr-message.user"),a=document.querySelector(".sr-message.assistant"),ur=u.getBoundingClientRect(),ar=a.getBoundingClientRect();return {sources:[...new Set(m.map(n=>n.querySelector(".sr-message-source").textContent))],userLeft:ur.left,userRight:ur.right,storyLeft:ar.left,storyRight:ar.right,bounded:m.every(n=>parseFloat(getComputedStyle(n).borderTopWidth)>=1&&getComputedStyle(n).backgroundColor!=="rgba(0, 0, 0, 0)"),textAlign:getComputedStyle(u).textAlign}})()');
  assert(style.sources.includes('我')&&style.sources.includes('故事')&&style.bounded&&style.userLeft>style.storyLeft+12&&Math.abs(style.userRight-style.storyRight)<=2&&style.textAlign!=="right",'User messages align right and narrative aligns left with readable message boundaries: '+JSON.stringify(style));
  await frame.until('!!document.querySelector("[data-preview-clue]")');
  await frame.evaluate('window.__historyNode=document.querySelector(".sr-message");window.__clueNode=document.querySelector("[data-preview-clue]");void 0');
  await frame.click('[data-preview-clue] button');
  const clueText=await frame.evaluate('document.querySelector("[data-preview-clue]").innerText');
  // Use actual reading input so a pending Portal/layout repair cannot be
  // mistaken for the reader's scroll intent during initial settling.
  await frame.evaluate('document.querySelector(".sr-chat-messages").focus({preventScroll:true});void 0');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});
  await frame.until('document.querySelector(".sr-chat-messages").scrollTop<1');
  await frame.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
  let before=await anchor();
  await frame.click('.sr-more');
  await frame.until('document.querySelectorAll(".sr-message").length===20');
  await assertAnchor(before,'Prepending five Runs preserves the reading anchor');
  assert(await frame.evaluate('document.querySelectorAll(".sr-message")[10]===window.__historyNode && document.querySelector("[data-preview-clue]")===window.__clueNode'),'History prepending preserves existing message and Portal nodes');
  assert(await frame.evaluate('document.querySelector("[data-preview-clue]").innerText')===clueText,'Portal local state survives history pagination');
  await frame.click('.sr-chat-messages > .sr-more');
  await frame.until('document.querySelectorAll(".sr-message").length===23 && !document.querySelector(".sr-chat-messages > .sr-more")');

  await frame.evaluate('document.querySelectorAll("[data-message-id]")[10].scrollIntoView({block:"start"})');
  await delay(140);before=await anchor();
  await frame.click('.sr-story-toolbar button');
  await assertAnchor(before,'Closing the docked state panel preserves the reading anchor');
  await frame.click('.sr-story-toolbar button');
  await assertAnchor(before,'Opening the docked state panel preserves the reading anchor');
  await click('[aria-label="收起侧边栏"]');
  await delay(300);
  await assertAnchor(before,'Sidebar width animation preserves the reading anchor');
  await click('[aria-label="展开侧边栏"]');
  await delay(300);

  before=await anchor();
  const shortHeight=await evaluate('document.querySelector("[data-session-composer]").getBoundingClientRect().height');
  await evaluate('window.__previewFrame=document.querySelector("iframe[data-story-preview]");void 0');
  await draft(Array.from({length:6},(_,i)=>'自动增高的草稿 '+i).join('\n'));
  await until('document.querySelector("[data-session-composer]").getBoundingClientRect().height>'+shortHeight+'+40');
  await delay(180);
  await assertAnchor(before,'Growing the glass composer preserves the reading anchor');
  assert(await evaluate('document.querySelector("iframe[data-story-preview]")===window.__previewFrame'),'Composer resizing must not remount the iframe');
  assert(await frame.evaluate('document.querySelector("[data-preview-clue]")===window.__clueNode'),'Composer resizing preserves Portal identity');
  await screenshot('session-glass-multiline-1536');
  await click('[aria-label="收起输入框"]');
  await assertAnchor(before,'Collapsing the floating composer preserves the reading anchor');
  await click('[aria-label="展开输入框"]');
  await until('document.querySelector(".sr-composer-editor").innerText.includes("自动增高的草稿")');
  await assertAnchor(before,'Expanding the floating composer preserves the reading anchor');
  await draft('');
  await until('document.querySelector("[data-session-composer]").getBoundingClientRect().height<='+shortHeight+'+1');
  await delay(180);
  await assertAnchor(before,'Clearing a multiline draft restores the single-line height and reading anchor');

  before=await anchor();
  await click('[aria-label="会话设置"]');
  await evaluate('(()=>{const e=document.querySelector("#preview-reading-size");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"20");e.dispatchEvent(new Event("input",{bubbles:true}))})()');
  await frame.until('getComputedStyle(document.querySelector(".sr-rich")).fontSize==="20px"');
  await assertAnchor(before,'Reading size preview preserves the reading anchor');
  await click('[aria-label="关闭弹窗"]');
  await frame.until('getComputedStyle(document.querySelector(".sr-rich")).fontSize==="16px"');

  before=await anchor();
  await frame.prepareImage();
  await frame.evaluate('(()=>{const img=document.createElement("img");img.dataset.delayedImage="true";document.querySelector(".sr-rich").append(img);img.src="https://sr-preview.invalid/deferred.svg"})()');
  await frame.until('document.querySelector("[data-delayed-image]").naturalHeight===260');
  await delay(350);
  await assertAnchor(before,'An image loading above the viewport preserves the reading anchor');
  assert(await frame.evaluate('!!document.querySelector(".sr-story-latest")'),'Reading older messages offers a return control');
  const latestBottom=await frame.evaluate('document.querySelector(".sr-story-latest").getBoundingClientRect().bottom');
  const latestHost=await evaluate('({frameTop:document.querySelector("iframe[data-story-preview]").getBoundingClientRect().top,overlayTop:document.querySelector("[data-composer-overlay]").getBoundingClientRect().top})');
  assert(latestBottom+latestHost.frameTop<=latestHost.overlayTop,'Return-to-latest remains above the glass composer');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await frame.click('.sr-story-latest button');
  await frame.until('(()=>{const c=document.querySelector(".sr-chat-messages");return c.scrollHeight-c.scrollTop-c.clientHeight<2})()');
  await send('Emulation.setEmulatedMedia',{features:[]});

  await draft('保留原来的草稿');
  await frame.click('.sr-suggestions button:not(:disabled)');
  await until('document.querySelector(".sr-composer-editor").innerText.includes("坐到窗边")');
  assert(await evaluate('document.querySelector("[data-session-detail]").dataset.previewActive')==='false','Choosing a suggestion only fills the draft');
  assert(!await evaluate('document.querySelector("[data-composer-overlay]").innerText.includes("已填入草稿")||[...document.querySelectorAll("[data-composer-overlay] button")].some(e=>e.textContent.includes("撤销"))||!!document.querySelector("[data-preview-notice]")'),'Suggestions fill the draft silently without confirmation or undo chrome');
  await draft('本轮发送的正文');
  await click('[aria-label="发送消息到本地预览"]');
  await until('document.querySelector("[data-session-detail]").dataset.previewActive==="true"');
  await draft('生成期间继续编辑的下一份草稿');
  assert(await frame.evaluate('document.querySelectorAll(".sr-suggestions button:not(:disabled)").length')===0,'Older suggestions become unavailable when a new Run begins');
  await finish();
  assert(await evaluate('document.querySelector(".sr-composer-editor").innerText')==='生成期间继续编辑的下一份草稿','Streaming and terminal events retain the next draft');
  assert(await frame.evaluate('document.querySelector("[data-preview-clue]")===window.__clueNode'),'Streaming preserves the historical Portal node');
  await screenshot('session-stream-completed-1536');
  await sendDraft('停止这次本地预览');
  await until('document.querySelector("[data-session-detail]").dataset.previewActive==="true"');
  await click('[aria-label="收起输入框"]');
  assert(!await evaluate('!!document.querySelector(".sr-composer-editor")'),'Active generation can keep the composer collapsed');
  await click('[aria-label="停止本地预览"]');
  await finish();
  await frame.until('document.body.innerText.includes("已停止生成")');

  await load();
  await frame.until('document.querySelector(".sr-story").dataset.stateMode==="docked" && !!document.querySelector("aside.sr-story-state")');
  await frame.click('.sr-story-toolbar button');
  await viewport(768,1024,false);
  await frame.until('document.querySelector(".sr-story").dataset.stateMode==="overlay"');
  await viewport(1536,900,false);
  await frame.until('document.querySelector(".sr-story").dataset.stateMode==="docked"');
  assert(!await frame.evaluate('!!document.querySelector(".sr-story-state")'),'Returning to wide mode preserves the closed dock preference');
  await frame.click('.sr-story-toolbar button');
  await viewport(768,1024,false);
  await frame.until('document.querySelector(".sr-story").dataset.stateMode==="overlay" && !document.querySelector(".sr-story-state")');
  await viewport(1536,900,false);
  await frame.until('!!document.querySelector("aside.sr-story-state")');
  await load('narrow');
  await frame.until('document.querySelector(".sr-story").dataset.stateMode==="overlay"');
  assert(await frame.evaluate('innerWidth>=960 && document.querySelector(".sr-story").clientWidth<960'),'A narrow author column uses overlay mode even in a wide viewport');
  await frame.click('.sr-story-toolbar button');
  await frame.until('!!document.querySelector("dialog[open]")');
  assert(await frame.evaluate('document.activeElement.getAttribute("aria-label")')==='收起状态','State overlay focuses its close button');
  const dialogBottom=await frame.evaluate('document.querySelector("dialog[open]").getBoundingClientRect().bottom');
  const dialogHost=await evaluate('({frameTop:document.querySelector("iframe[data-story-preview]").getBoundingClientRect().top,overlayTop:document.querySelector("[data-composer-overlay]").getBoundingClientRect().top})');
  assert(dialogHost.frameTop+dialogBottom<=dialogHost.overlayTop,'The iframe state dialog stays above the Host glass composer');
  for(let i=0;i<8;i++){
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    const focus=await frame.evaluate('({inside:document.querySelector("dialog").contains(document.activeElement),tag:document.activeElement.tagName,text:document.activeElement.textContent?.slice(0,60)})');
    const hostFocus=await evaluate('document.activeElement===document.querySelector("iframe[data-story-preview]")');
    assert(focus.inside&&hostFocus,'Tab remains within the native state dialog: '+JSON.stringify({focus,hostFocus}));
  }
  await frame.evaluate('document.querySelector("dialog button").focus()');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
  assert(await frame.evaluate('document.querySelector("dialog").contains(document.activeElement)')&&await evaluate('document.activeElement===document.querySelector("iframe[data-story-preview]")'),'Shift+Tab wraps within the state dialog');
  await screenshot('session-state-overlay-wide-column');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await frame.until('!document.querySelector("dialog[open]")');
  await frame.until('document.activeElement===document.querySelector(".sr-story-toolbar button")');
  await frame.click('.sr-story-toolbar button');
  const frameBounds=await evaluate('(()=>{const r=document.querySelector("iframe[data-story-preview]").getBoundingClientRect();return {x:r.left+5,y:r.top+80}})()');
  await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...frameBounds});
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...frameBounds});
  await frame.until('!document.querySelector("dialog[open]")');
  await frame.until('document.activeElement===document.querySelector(".sr-story-toolbar button")');

  await load('','neon');
  await frame.until('!!document.querySelector("[data-preview-composed]") && document.querySelectorAll(".sr-message").length===10');
  assert(await frame.evaluate('!document.querySelector(".sr-story-toolbar button")&&!document.querySelector(".sr-story-state")'),'showState=false removes the official entry, panel and overlay');
  await frame.click('.preview-scene-state button');
  await until('document.querySelector(".sr-composer-editor").innerText.includes("拿起芯片")');
  await sendDraft('我检查芯片的刻痕。');
  await finish();
  await frame.until('document.querySelector("[data-preview-clues]").textContent==="4"');
  const dark=await frame.evaluate('getComputedStyle(document.querySelector(".sr-story")).color');
  await evaluate('document.documentElement.dataset.theme="light"');
  await frame.until('getComputedStyle(document.querySelector(".sr-story")).color!=='+JSON.stringify(dark));
  await screenshot('session-neon-light-1536');

  for(const [scenario,text] of [['history-error','历史消息加载失败'],['earlier-error','加载历史失败'],['state-error','状态加载失败']]){
    await load(scenario);
    if(scenario==='earlier-error'){
      await frame.until('(()=>{const b=document.querySelector(".sr-chat-messages > button.sr-more");return !!b&&!b.disabled})()');
      await frame.click('.sr-chat-messages > button.sr-more');
    }
    await frame.until('document.body.innerText.includes('+JSON.stringify(text)+')');
    const selector=scenario==='state-error'?'.sr-state-error button':scenario==='earlier-error'?'.sr-chat-messages > .sr-more':'.sr-error button';
    await frame.click(selector);
    await frame.until('!document.body.innerText.includes('+JSON.stringify(text)+')');
  }
  await load('send-error');
  await sendDraft('发送失败时仍要保留');
  await until('document.querySelector("[data-preview-notice]")?.textContent.includes("发送被拒绝")');
  assert(await evaluate('document.querySelector(".sr-composer-editor").innerText')==='发送失败时仍要保留','A rejected send preserves the draft');
  for(const [scenario,feedback] of [['run-failed','本次生成失败'],['state-partial','部分状态更新'],['suggestion-failed','本轮行动建议不可用'],['snapshot',''],['gap','']]){
    await load(scenario);
    await frame.until('document.querySelectorAll(".sr-message").length===10');
    await frame.evaluate('window.__beforeRunNode=document.querySelector(".sr-message");void 0');
    await sendDraft('验证 '+scenario);
    if(scenario==='snapshot'||scenario==='gap'){
      await frame.until('document.querySelector(".sr-thinking[role=status]")?.textContent.includes("正文已生成") && [...document.querySelectorAll(".sr-message.assistant")].at(-1).textContent.includes("下一步由你决定。")');
      const live=await frame.evaluate('(()=>{const text=[...document.querySelectorAll(".sr-message.assistant")].at(-1).textContent;return {text,first:text.split("对方听完你的话").length-1,last:text.split("下一步由你决定").length-1,stable:document.querySelector(".sr-message")===window.__beforeRunNode,busy:!!document.querySelector(".sr-thinking[role=status]")}})()');
      assert(live.busy&&live.first===1&&live.last===1&&live.stable&&!live.text.includes('�'),'Snapshot/gap recovery must repair live text before authoritative terminal messages: '+JSON.stringify(live));
      assert(await evaluate('document.querySelector("[data-session-detail]").dataset.previewActive')==='true','Live recovery assertion occurs before the terminal event');
    }
    await finish();
    assert(await evaluate('window.__previewPhases.slice(-4).join(",")')==='preparing,narrative,extensions,idle','Run phases must preserve their observable order');
    if(feedback)await frame.until('document.body.innerText.includes('+JSON.stringify(feedback)+')');
    if(scenario==='run-failed')assert(await frame.evaluate('document.querySelectorAll("[data-message-id*=\\":preview:\\"]").length')===0,'Failed terminal messages replace uncommitted provisional text');
    if(scenario==='state-partial'||scenario==='suggestion-failed')assert(await frame.evaluate('document.querySelectorAll(".sr-suggestions button:not(:disabled)").length')===0,'Unavailable extension results never expose actionable suggestions');
    if(scenario==='snapshot'||scenario==='gap'){
      const text=await frame.evaluate('[...document.querySelectorAll(".sr-message.assistant")].at(-1).textContent');
      assert(text.includes('你把这条线索记下来。')&&!text.includes('�'),'Snapshot/gap recovery restores the complete Unicode narrative');
    }
  }
  await load('empty');
  await frame.until('document.body.innerText.includes("故事尚未开始")');
  for(const scenario of ['component-error','missing-component']){
    await load(scenario);
    const fallback=scenario==='component-error'?'组件显示失败，已保留原文':'消息组件不可用，已保留原文';
    const token=scenario==='component-error'?'[[线索卡]]':'[[缺失组件]]';
    await frame.until('(()=>{const m=document.querySelector(\'[data-message-id="changan:history:012:assistant"]\');return !!m&&m.textContent.includes('+JSON.stringify(token)+')&&[...m.querySelectorAll("small[role=status]")].some(n=>n.textContent.includes('+JSON.stringify(fallback)+'))})()');
    assert(await frame.evaluate('document.querySelectorAll(".sr-message").length===10 && !document.querySelector("[data-preview-page-error]")'),'A local message component problem preserves the rest of the story');
  }
  await open('/sessions/changan','page-error');
  frame=await createPreviewDriver(ctx);
  await frame.until('!!document.querySelector("[role=alert]")');
  assert(!await evaluate('document.querySelector("[data-session-detail]").dataset.previewActive==="true"'),'A root page error does not leave a busy preview');
  console.log('PASS: real SDK history/Portal, reading anchors, state dialog, draft lifecycle, stream/stop, themes, error isolation and opaque-frame CSP.');
}
