import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
export async function verifyRuntime(call,pause){
  const evaluate=async expression=>{
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const assert=(value,message)=>{if(!value)throw Error('runtime-v2: '+message);console.log('PASS runtime-v2: '+message);};
  let frameSession,contextId;
  for(let i=0;i<120&&!frameSession&&!contextId;i++){
    const iframeUrl=await evaluate('document.querySelector("iframe")?.getAttribute("src")');
    const nonce=typeof iframeUrl==='string'?iframeUrl.split('#').pop():'';
    if(!nonce){await pause(100);continue;}
    const targets=await call('Target.getTargets');
    const target=targets.targetInfos.find(t=>t.type==='iframe'&&t.url.includes('/frame.html')&&t.url.includes(nonce));
    if(target){frameSession=(await call('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;await call('Runtime.enable',{},frameSession);}
    else{
      const tree=await call('Page.getFrameTree'),frame=tree.frameTree.childFrames?.find(t=>t.frame.url.includes('/frame.html')&&t.frame.url.includes(nonce));
      if(frame)contextId=(await call('Page.createIsolatedWorld',{frameId:frame.frame.id,worldName:'sr-runtime-regression',grantUniveralAccess:true})).executionContextId;
    }
    if(!frameSession&&!contextId)await pause(100);
  }
  assert(frameSession||contextId,'uses the real sandboxed story iframe');
  const frameEval=async expression=>{
    const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...(contextId?{contextId}:{})},frameSession);
    if(result.exceptionDetails)throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  for(let i=0;i<150;i++){if(await frameEval('document.querySelectorAll(".sr-suggestions button").length')===3)break;await pause(100);}
  const available=await frameEval('document.querySelectorAll(".sr-suggestions button:not(:disabled)").length');
  if(available!==3)throw Error('runtime-v2 initial render: '+JSON.stringify({available,frame:await frameEval('document.body.innerText'),host:await evaluate('document.querySelector(".host")?.innerText')}));
  assert(available===3,'restores suggestions from persisted results');
  const screenshot=async name=>{
    if(!process.env.SR_QA_SCREENSHOT_DIR)return;
    await mkdir(process.env.SR_QA_SCREENSHOT_DIR,{recursive:true});
    const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    await writeFile(join(process.env.SR_QA_SCREENSHOT_DIR,name+'.png'),Buffer.from(shot.data,'base64'));
  };
  for(const width of [1280,375]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:812,deviceScaleFactor:1,mobile:width<600});await pause(160);
    if(width<600)await frameEval('document.querySelector(".sr-story-state > button")?.click()');await pause(100);
    const layout=JSON.parse(await evaluate('JSON.stringify({width:document.documentElement.clientWidth,scroll:document.querySelector(".host").scrollWidth})'));
    assert(layout.scroll<=layout.width+1,width+'px host does not overflow');
    const story=JSON.parse(await frameEval('JSON.stringify({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll(".sr-suggestions button")].map(b=>b.getBoundingClientRect().right)})'));
    assert(story.scroll<=story.width+1&&story.buttons.every(right=>right<=story.width+1),width+'px suggestion buttons fit the viewport');
    await screenshot('runtime-story-'+width);
    await evaluate('document.querySelector(".host-settings-button").click()');await pause(150);
    assert(await evaluate('document.querySelectorAll(".host-capability-settings select").length')===2,'shows inherited capability controls at '+width+'px');
    await screenshot('runtime-settings-'+width);
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await pause(100);
    assert(!await evaluate('!!document.querySelector(".host-settings-dialog")'),'Escape closes settings at '+width+'px');
  }
  await evaluate('(()=>{const e=document.querySelector("[contenteditable]");e.focus();document.execCommand("insertText",false,"我的原稿")})()');await pause(100);
  await frameEval('document.querySelector(".sr-suggestions button").click()');await pause(100);
  assert(await evaluate('document.querySelector("[contenteditable]").innerText.includes("观察大厅")'),'suggestion fills the Host draft');
  assert(await evaluate('__runtimeTest.calls.filter(c=>c.path.endsWith("/runs")).length')===0,'suggestion never sends automatically');
  await evaluate('document.querySelector(".host-draft-undo button").click()');await pause(100);
  assert(await evaluate('document.querySelector("[contenteditable]").innerText.includes("我的原稿")'),'undo restores the replaced draft');
  await frameEval('document.querySelector(".sr-suggestions button").click()');await pause(100);
  await evaluate('(()=>{const e=document.querySelector("[contenteditable]");e.focus();document.execCommand("insertText",false,"之后编辑")})()');await pause(100);
  assert(!await evaluate('!!document.querySelector(".host-draft-undo")'),'editing invalidates the one-time draft undo');
  await evaluate('__runtimeTest.begin()');await pause(150);
  assert(await frameEval('document.querySelectorAll(".sr-suggestions button:not(:disabled)").length')===0,'starting a new Run disables historical suggestions');
  await evaluate('document.querySelector(".host-settings-button").click()');await pause(150);
  assert(await evaluate('[...document.querySelectorAll(".host-settings-fields label")].find(e=>e.textContent.startsWith("执行模式")).querySelector("select").disabled'),'busy mode cannot be changed');
  assert(await evaluate('document.querySelector(".host-current-capabilities").innerText.includes("本轮使用：状态更新开启")'),'shows the frozen current Run settings separately from next-run overrides');
  await evaluate('(()=>{const e=document.querySelector(".host-capability-settings select");e.value="false";e.dispatchEvent(new Event("change",{bubbles:true}))})()');await pause(80);
  await evaluate('document.querySelector(".host-settings-dialog-footer .primary").click()');await pause(120);
  assert(await evaluate('__runtimeTest.calls.some(c=>c.path.endsWith("/capabilities")&&c.body.overrides.state_update===false)'),'capability overrides can be saved while busy for the next Run');
  await evaluate('__runtimeTest.disconnect();__runtimeTest.finishOffline();__runtimeTest.reconnect()');await pause(250);
  assert(await frameEval('document.body.innerText.includes("书房门开了。")'),'reconnection restores a missed terminal response');
  await evaluate('__runtimeTest.late()');await pause(120);
  assert(!await evaluate('!!document.querySelector(".host-phase")'),'late preparation cannot resurrect a terminal Run');
  assert(await evaluate('document.querySelector("[contenteditable]").innerText.includes("之后编辑")'),'recovery and terminal events preserve subsequent draft edits');
  await evaluate('__runtimeTest.restartPreparing()');await pause(100);
  assert(await evaluate('!!document.querySelector(".host-phase")'),'pre-entry preparation is visible');
  await evaluate('__runtimeTest.disconnect();__runtimeTest.losePreparation();__runtimeTest.reconnect()');await pause(250);
  assert(!await evaluate('!!document.querySelector(".host-phase")'),'restart without a durable preparation entry releases busy state');
  assert(await evaluate('document.querySelector("[contenteditable]").innerText.includes("之后编辑")'),'interrupted preparation preserves the draft');
  const previousFrame=await evaluate('document.querySelector("iframe").getAttribute("src")');
  await evaluate('__runtimeTest.switchSession()');await pause(200);
  assert(await evaluate('document.querySelector("iframe").getAttribute("src")')!==previousFrame,'switching sessions replaces the iframe nonce');
  await evaluate('(()=>{const e=document.querySelector("[contenteditable]");e.focus();document.execCommand("insertText",false,"新会话草稿")})()');
  let canSend=false;
  for(let i=0;i<100;i++){canSend=await evaluate('!document.querySelector(".host-send-button").disabled');if(canSend)break;await pause(100);}
  assert(canSend,'switching sessions creates a fresh working iframe handshake');


}
