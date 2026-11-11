/**
 * Preset workbench regression, called from the existing Chrome CDP capture runner.
 * Exercises rendered controls with native mouse, keyboard, wheel and pointer drag input.
 */
export async function checkPresets({send,evaluate,until,viewport,click,screenshot,delay,assert,base,hover,bg}){
  const json=JSON.stringify;
  const run=(fn,...args)=>evaluate('('+fn.toString()+')('+args.map(json).join(',')+')');
  const item=id=>'[data-preset-item='+json(id)+']';
  const row=id=>'[data-custom-node='+json(id)+']';
  const fieldName='input[aria-label="预设名称"]';
  const fieldDescription='input[aria-label="预设描述"]';
  const prompt='[role="dialog"] textarea[aria-label="提示词正文"]';
  const nodeName='[role="dialog"] input[aria-label="节点名称"]';
  const mouseDelay=160;
  const keyCodes={Tab:9,Enter:13,Escape:27,Home:36,End:35,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,PageUp:33,PageDown:34,' ':32};
  async function key(name,modifiers=0){
    const args={key:name,code:name===' '?'Space':name,windowsVirtualKeyCode:keyCodes[name]??0,modifiers};
    await send('Input.dispatchKeyEvent',{type:'keyDown',...args});
    await send('Input.dispatchKeyEvent',{type:'keyUp',...args});
    await delay(70);
  }
  async function point(selector){
    const result=await run(async function(selector){
      const element=document.querySelector(selector);
      if(!element)return null;
      element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      // An inserted node may still be scrolling into view. Wait for actual
      // geometry to settle before dispatching a physical click at its center.
      let previous=null,stable=0;
      for(let frame=0;frame<60;frame++){
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const bounds=element.getBoundingClientRect();
        stable=previous&&Math.abs(bounds.top-previous.top)<.25&&Math.abs(bounds.left-previous.left)<.25?stable+1:0;
        previous={top:bounds.top,left:bounds.left};
        if(stable>=3)break;
      }
      const r=element.getBoundingClientRect();
      const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,width:r.width,height:r.height,hit:!!hit&&(element===hit||element.contains(hit)),disabled:element.disabled===true};
    },selector);
    assert(result&&result.width>0&&result.height>0&&result.hit&&!result.disabled,'Preset control is not hittable: '+selector+' '+json(result));
    return {x:result.x,y:result.y};
  }
  async function pressAt(location){
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...location});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...location,button:'left',buttons:1,clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...location,button:'left',buttons:0,clickCount:1});
    await delay(mouseDelay);
  }
  async function pointerClick(selector){await pressAt(await point(selector));}
  async function buttonText(text,scope='[data-preset-workspace]'){
    const result=await run(function(text,scope){
      const root=document.querySelector(scope);
      const element=[...(root?.querySelectorAll('button')??[])].find(button=>button.textContent.trim()===text&&!button.disabled&&button.getClientRects().length);
      if(!element)return null;
      element.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
      const r=element.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,hit:!!hit&&(element===hit||element.contains(hit))};
    },text,scope);
    assert(result?.hit,'Missing or obscured preset action: '+text);
    await pressAt({x:result.x,y:result.y});
  }
  async function fill(selector,value){
    await pointerClick(selector);
    const modifiers=await evaluate('/Mac/.test(navigator.platform)?4:2');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers,commands:['selectAll']});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:0});
    await send('Input.insertText',{text:value});
    await until('document.querySelector('+json(selector)+')?.value==='+json(value));
    assert(await evaluate('document.activeElement===document.querySelector('+json(selector)+')'),'Typing should not reset dialog/form focus: '+selector);
  }
  async function open(path='/presets'){
    const previousDocument=await evaluate('performance.timeOrigin');
    await send('Page.navigate',{url:base+path+(path.includes('?')?'&':'?')+'sidebar=expanded&theme=dark'});
    await until('performance.timeOrigin!=='+previousDocument+' && document.readyState==="complete" && location.pathname==='+json(new URL(path,base).pathname)+' && !!document.querySelector("[data-preset-workspace]") && document.querySelectorAll("[data-preset-item]").length>0');
    await delay(350);
  }
  async function select(id){
    await pointerClick(item(id));
    await until('location.pathname==='+json('/presets/'+id)+' && document.querySelector('+json(item(id))+')?.getAttribute("aria-pressed")==="true" && document.querySelector("[data-preset-content]")?.getBoundingClientRect().width>0');
  }
  async function metrics(){
    return run(async function(){
      // Read stable geometry after a viewport resize or native wheel sequence.
      let last='',stable=0;
      for(let frame=0;frame<60;frame++){
        await new Promise(resolve=>requestAnimationFrame(resolve));
        const sample=[...document.querySelectorAll('[data-preset-list],[data-preset-content]')].map(el=>[el.scrollTop,el.clientWidth,el.clientHeight]).flat().join(',');
        stable=sample===last?stable+1:0;last=sample;
        if(stable>=3)break;
      }
      const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
      const list=document.querySelector('[data-preset-list]'),content=document.querySelector('[data-preset-content]'),main=document.getElementById('main-content');
      return {list:rect(list),content:content?rect(content):null,listTop:list.scrollTop,listRange:list.scrollHeight-list.clientHeight,
        contentTop:content?.scrollTop??0,contentRange:content?content.scrollHeight-content.clientHeight:0,
        mainTop:main.scrollTop,pageTop:document.scrollingElement.scrollTop,pageWidth:document.documentElement.scrollWidth,width:innerWidth,height:innerHeight};
    });
  }
  async function wheel(selector,deltaY){
    const position=await run(function(selector){
      const r=document.querySelector(selector).getBoundingClientRect();
      return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2};
    },selector);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...position});
    await send('Input.dispatchMouseEvent',{type:'mouseWheel',...position,deltaX:0,deltaY});
    await delay(280);
  }
  async function nodeOrder(){return evaluate('[...document.querySelectorAll("[data-custom-node]")].map(row=>row.dataset.customNode)');}
  async function discardDialog(){
    await buttonText('取消','[role="dialog"]');
    const needsDiscard=await evaluate('[...document.querySelectorAll("[role=dialog] button")].some(button=>button.textContent.trim()==="放弃修改")');
    if(needsDiscard)await buttonText('放弃修改','[role="dialog"]');
    await until('!document.querySelector("[role=dialog]")');
  }
  async function save(){
    await pointerClick('button[aria-label="保存预设"]');
    await until('document.querySelector(\'button[aria-label="保存预设"]\').disabled');
  }
  async function modalGeometry(label){
    const shape=await run(function(){
      const dialog=document.querySelector('[role=dialog]'),footer=dialog.querySelector('footer'),header=dialog.querySelector('header');
      const r=dialog.getBoundingClientRect(),f=footer.getBoundingClientRect(),h=header.getBoundingClientRect();
      return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,footerTop:f.top,footerBottom:f.bottom,headerTop:h.top,width:innerWidth,height:innerHeight};
    });
    assert(shape.left>=-1&&shape.right<=shape.width+1&&shape.top>=0&&shape.bottom<=shape.height+1,label+': editor dialog overflows viewport '+json(shape));
    assert(shape.footerTop>shape.headerTop&&shape.footerBottom<=shape.height+1,label+': editor actions must remain visible');
    assert(await evaluate('document.getElementById("root").inert'),label+': background must remain inert');
    return shape;
  }
  async function focusTrap(){
    for(let i=0;i<10;i++){
      if(await evaluate('document.activeElement?.getAttribute("aria-label")==="关闭弹窗"'))break;
      await key('Tab');
    }
    assert(await evaluate('document.activeElement?.getAttribute("aria-label")==="关闭弹窗"'),'Tab should reach the dialog close control');
    await key('Tab',8);
    assert(await evaluate('document.activeElement?.closest("footer")!==null && document.activeElement?.textContent.trim()==="应用"'),'Shift+Tab should wrap from close to Apply');
    await key('Tab');
    assert(await evaluate('document.activeElement?.getAttribute("aria-label")==="关闭弹窗"'),'Tab should wrap from Apply to the dialog close control');
  }

  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'},{name:'hover',value:'hover'},{name:'pointer',value:'fine'}]});
  await viewport(1536,864);
  await open();
  const initial=await run(function(){
    return [...document.querySelectorAll('[data-preset-item]')].map(element=>({
      id:element.dataset.presetItem,title:(element.querySelector('[data-preset-title]')??element.querySelector('strong')).textContent,
      description:(element.querySelector('[data-preset-description]')??element.lastElementChild).textContent
    }));
  });
  assert(initial.length===7,'Expected seven preset fixtures, got '+initial.length);
  const first=initial[0],second=initial[1],ensemble=initial.find(entry=>entry.title.includes('群像'));
  assert(ensemble,'Missing long-form ensemble fixture for scroll regression');
  const twoColumns=await metrics();
  assert(twoColumns.list.width>=230&&twoColumns.list.width<=340,'Preset list width is outside the intended desktop range');
  assert(twoColumns.content.left>=twoColumns.list.right-1&&twoColumns.content.width>=450,'Desktop preset editor must occupy a distinct, usable right column');
  assert(twoColumns.pageWidth<=1536&&twoColumns.pageTop===0&&twoColumns.mainTop===0,'Preset workbench must fit its viewport');
  assert(await evaluate('document.querySelectorAll("[data-preset-workspace] input[aria-label*=标签]").length===0'),'Removed preset tags must not leave tag controls');
  const listLines=await run(function(){
    return [...document.querySelectorAll('[data-preset-item]')].every(item=>{
      const title=item.querySelector('[data-preset-title]')??item.querySelector('strong');
      const description=item.querySelector('[data-preset-description]')??item.lastElementChild;
      const a=title.getBoundingClientRect(),b=description.getBoundingClientRect(),s=getComputedStyle(description);
      return b.top>=a.bottom-2&&s.whiteSpace==='nowrap'&&s.textOverflow==='ellipsis'&&b.height<=22;
    });
  });
  assert(listLines,'Preset items must consist of a title line and one ellipsized description line');
  await screenshot('presets-desktop-1536');
  await delay(250);
  const selectedSidebar='a[aria-label="预设列表"][aria-current="page"]';
  const sidebarBackground=await bg(selectedSidebar);
  await hover(selectedSidebar);
  assert(await bg(selectedSidebar)===sidebarBackground,'Selected preset sidebar navigation changes color on hover');
  const selectedItem='[data-preset-item][aria-pressed="true"]';
  const itemBackground=await bg(selectedItem);
  await hover(selectedItem);
  assert(await bg(selectedItem)===itemBackground,'Selected preset row changes background on hover');

  // Non-tenth fixture temperatures must not block an unrelated name save
  // while the advanced section (and its temperature input) stays collapsed.
  for(const [title,temperature] of [['日常相处',.95],['群像长篇',.85]]){
    const fixture=initial.find(entry=>entry.title===title);
    assert(fixture,'Missing temperature boundary fixture: '+title);
    await select(fixture.id);
    assert(await evaluate('document.querySelector("[data-preset-content] details")?.open')===false,title+': advanced settings should start collapsed');
    assert(await evaluate('Number(document.querySelector(\'input[aria-label="温度"]\').value)')===temperature,title+': expected the fractional temperature fixture');
    await fill(fieldName,title+' · 保存回归');
    await save();
    assert(await evaluate('document.querySelector('+json(fieldName)+').value')===title+' · 保存回归',title+': an unrelated name edit failed to save');
    assert(await evaluate('document.querySelector("[data-preset-content] details")?.open')===false,title+': saving should not require opening advanced settings');
    await fill(fieldName,title);
    await save();
  }

  // A real overflowing right pane, then a shorter viewport makes the left list scroll too.
  await select(ensemble.id);
  assert((await nodeOrder()).length===16,'Ensemble fixture should exercise sixteen custom nodes');
  let before=await metrics();
  assert(before.contentRange>100,'Long preset should require editor scrolling');
  await wheel('[data-preset-content]',290);
  let after=await metrics();
  assert(after.contentTop>before.contentTop+40&&after.listTop===before.listTop&&after.mainTop===before.mainTop&&after.pageTop===before.pageTop,'Editor wheel must not scroll the list or outer page');
  await viewport(1536,480);
  await delay(200);
  before=await metrics();
  assert(before.listRange>10,'Short viewport must make the seven-row preset list scrollable');
  await wheel('[data-preset-list]',180);
  after=await metrics();
  assert(after.listTop>before.listTop+10&&Math.abs(after.contentTop-before.contentTop)<2&&after.mainTop===before.mainTop,'List wheel must not scroll the editor or outer page: '+json({before,after}));
  await viewport(1536,864);
  await delay(200);
  await select(first.id);
  const originalName=await evaluate('document.querySelector('+json(fieldName)+').value');
  const draftName='回归验证 · 长叙事';
  const longDescription='这是验证两行预设列表单行省略的长描述。'.repeat(12);
  await fill(fieldName,draftName);
  await fill(fieldDescription,longDescription);
  const ellipsis=await run(function(id){
    const item=document.querySelector('[data-preset-item="'+id+'"]');
    const description=item.querySelector('[data-preset-description]')??item.lastElementChild;
    const s=getComputedStyle(description);
    return {width:description.clientWidth,scroll:description.scrollWidth,overflow:s.overflow,textOverflow:s.textOverflow,whiteSpace:s.whiteSpace};
  },first.id);
  assert(ellipsis.scroll>ellipsis.width&&ellipsis.textOverflow==='ellipsis'&&ellipsis.whiteSpace==='nowrap','Long descriptions should overflow within one ellipsized row');
  await select(second.id);
  await select(first.id);
  assert(await evaluate('document.querySelector('+json(fieldName)+').value')===draftName,'Switching presets lost an unsaved name');
  await pointerClick('a[aria-label="世界卡"]');
  await pointerClick('a[aria-label="预设列表"]');
  await until('!!document.querySelector("[data-preset-workspace]")');
  await select(first.id);
  assert(await evaluate('document.querySelector('+json(fieldName)+').value')===draftName,'SPA route navigation lost the preset draft');
  assert(await evaluate('document.querySelector('+json(fieldDescription)+').value')===longDescription,'SPA route navigation lost the draft description');
  await save();
  await fill(fieldName,'应被放弃的名称');
  await pointerClick('button[aria-label="更多预设操作"]');
  await buttonText('放弃更改','[data-preset-menu]');
  assert(await evaluate('document.querySelector('+json(fieldName)+').value')===draftName,'Discard changes failed to restore the saved snapshot');
  assert(await evaluate('document.activeElement===document.querySelector(\'button[aria-label="更多预设操作"]\')'),'Discard changes should return focus to the preset menu trigger');
  assert(await evaluate('document.querySelector(\'button[aria-label="保存预设"]\').disabled'),'Restoring a saved snapshot should clear dirty state');

  // Search has a real empty result and can recover without losing the selection/draft.
  await fill('input[aria-label="搜索预设"]','没有匹配的预设-回归');
  assert(await evaluate('document.querySelectorAll("[data-preset-item]").length')===0,'Preset search should filter the actual list');
  await pointerClick('button[aria-label="清空搜索"]');
  assert(await evaluate('document.querySelectorAll("[data-preset-item]").length')===7,'Clearing search should restore all presets');
  await pointerClick('label:has(input[type="radio"][value="compact"])');
  assert(await evaluate('document.querySelector(\'input[type="radio"][value="compact"]\').checked'),'Context strategy control did not select compact');

  // Apply a built-in prompt, then exercise a much longer draft without applying it.
  await pointerClick('button[aria-label="编辑叙事风格"]');
  await until('!!document.querySelector("[role=dialog] textarea")');
  const originalStyle=await evaluate('document.querySelector('+json(prompt)+').value');
  const appliedStyle=originalStyle+'\n回归：保留世界与人物已有事实。';
  await fill(prompt,appliedStyle);
  await buttonText('应用','[role="dialog"]');
  await until('!document.querySelector("[role=dialog]")');
  await pointerClick('button[aria-label="编辑叙事风格"]');
  assert(await evaluate('document.querySelector('+json(prompt)+').value')===appliedStyle,'Applying narrative style failed to update the preset draft');
  const longPrompt=Array.from({length:90},(_,index)=>'第 '+(index+1)+' 段：保持人物、时间与因果连续，并在需要玩家回应处停下。').join('\n');
  await fill(prompt,longPrompt);
  await modalGeometry('1536');
  await focusTrap();
  await screenshot('presets-prompt-editor-1536');
  await viewport(1280,560);
  await delay(200);
  const dialogBefore=await modalGeometry('1280-short');
  const bodyState=await run(function(){
    const body=document.querySelector('[role=dialog] form').parentElement;
    const r=body.getBoundingClientRect();
    return {range:body.scrollHeight-body.clientHeight,top:body.scrollTop,x:r.right-5,y:(r.top+r.bottom)/2};
  });
  assert(bodyState.range>10,'Long prompt form should have a scrollable dialog body on a short screen');
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:bodyState.x,y:bodyState.y,deltaX:0,deltaY:320});
  await delay(250);
  const dialogAfter=await modalGeometry('1280-short-scrolled');
  const bodyTop=await evaluate('document.querySelector("[role=dialog] form").parentElement.scrollTop');
  assert(bodyTop>bodyState.top&&Math.abs(dialogAfter.footerTop-dialogBefore.footerTop)<2&&Math.abs(dialogAfter.headerTop-dialogBefore.headerTop)<2,'Dialog body scrolling must keep header and footer fixed');
  await viewport(1536,864);
  await delay(180);
  await pressAt({x:8,y:8});
  assert(await evaluate('!!document.querySelector("[role=dialog]")'),'Editor backdrop should not discard a prompt draft');
  await key('Escape');
  assert(await evaluate('[...document.querySelectorAll("[role=dialog] button")].some(button=>button.textContent.trim()==="放弃修改")'),'Dirty Escape should offer discard without closing');
  await buttonText('继续编辑','[role="dialog"]');
  assert(await evaluate('document.querySelector('+json(prompt)+').value')===longPrompt,'Continue editing lost the dialog draft');
  await discardDialog();
  await pointerClick('button[aria-label="编辑叙事风格"]');
  assert(await evaluate('document.querySelector('+json(prompt)+').value')===appliedStyle,'Discarding the long prompt changed the applied narrative style');
  await discardDialog();

  const beforeAdd=await nodeOrder();
  await pointerClick('button[aria-label="添加自定义节点"]');
  await until('!!document.querySelector(\'[role=dialog] input[aria-label="节点名称"]\')');
  await fill(nodeName,'回归自定义节点');
  // Native type-ahead selects the role without relying on an OS popup in
  // macOS headless Chrome. These are real key events, not a DOM value setter.
  await key('Tab');
  assert(await evaluate('document.activeElement?.getAttribute("aria-label")==="消息角色"'),'Tab should reach the role selector');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'u',code:'KeyU',windowsVirtualKeyCode:85,text:'u'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'u',code:'KeyU',windowsVirtualKeyCode:85});
  await key('Tab');
  assert(await evaluate('document.querySelector(\'[role=dialog] select[aria-label="消息角色"]\').value')==='user','Native select did not change the message role');
  const nodePrompt='保留人物之间的信息差。\n不要替玩家作出重要决定。';
  await fill(prompt,nodePrompt);
  await buttonText('应用','[role="dialog"]');
  await until('!document.querySelector("[role=dialog]") && document.querySelectorAll("[data-custom-node]").length==='+String(beforeAdd.length+1));
  const newId=(await nodeOrder()).find(id=>!beforeAdd.includes(id));
  assert(newId,'Applying a new custom node did not create a row');
  const switchSelector=row(newId)+' [role="switch"]';
  const checked=await evaluate('document.querySelector('+json(switchSelector)+').getAttribute("aria-checked")');
  await pointerClick(switchSelector);
  assert(await evaluate('document.querySelector('+json(switchSelector)+').getAttribute("aria-checked")')!==checked,'Node switch did not change enabled state');
  assert(await evaluate('!document.querySelector("[role=dialog]")'),'Toggling a node should not open its editor');
  await pointerClick(row(newId)+' button[aria-label^="编辑节点："]');
  assert(await evaluate('document.querySelector('+json(prompt)+').value')===nodePrompt,'New node prompt was not retained');
  assert(await evaluate('document.querySelector(\'[role=dialog] select[aria-label="消息角色"]\').value')==='user','New node message role was not retained');
  await fill(nodeName,'这次修改应被取消');
  await fill(prompt,'这次正文修改也应被取消');
  await discardDialog();
  await pointerClick(row(newId)+' button[aria-label^="编辑节点："]');
  assert(await evaluate('document.querySelector('+json(nodeName)+').value')==='回归自定义节点','Cancel changed the node name');
  assert(await evaluate('document.querySelector('+json(prompt)+').value')===nodePrompt,'Cancel changed the node prompt');
  await fill(nodeName,'回归节点已编辑');
  await fill(prompt,nodePrompt+'\n让冲突通过行动逐步推进。');
  await buttonText('应用','[role="dialog"]');
  await until('!document.querySelector("[role=dialog]")');
  assert(await evaluate('document.querySelector('+json(row(newId)+' button[aria-label^="编辑节点："]')+').getAttribute("aria-label")')==='编辑节点：回归节点已编辑','Applying an edit did not update the node row');

  // Native keyboard movement uses the same visible drag handle as pointer input.
  const handle=row(newId)+' button[aria-label^="拖动节点："]';
  const orderBeforeKey=await nodeOrder(),keyIndex=orderBeforeKey.indexOf(newId);
  assert(keyIndex>0,'Keyboard move test needs a preceding custom node');
  await pointerClick(handle);
  await key('ArrowUp');
  await until('[...document.querySelectorAll("[data-custom-node]")].findIndex(row=>row.dataset.customNode==='+json(newId)+')==='+String(keyIndex-1));
  await key('ArrowDown');
  assert(json(await nodeOrder())===json(orderBeforeKey),'Keyboard ArrowDown should restore the prior node order');
  assert(await evaluate('!document.querySelector("[role=dialog]")'),'Keyboard reordering should not trigger node editing');

  assert(await evaluate('!document.querySelector("[data-custom-node][data-dragging=true]") && !document.querySelector("[data-custom-node][data-drop]")'),'Keyboard movement should not leave pointer drag or drop state behind');

  // Pointer capture must not treat dropping outside the custom-node group as
  // an insertion at the beginning/end of that group.
  for(const destination of ['library','fixed-source']){
    await run(function(){
      document.querySelector('[data-custom-group]').scrollIntoView({block:'center',behavior:'instant'});
    });
    const unchanged=await nodeOrder();
    // Move the first row toward the end: a clamp-to-last implementation would
    // visibly reorder it, so this does not pass merely because it was last.
    const outsideId=unchanged[0];
    const dragFrom=await point(row(outsideId)+' button[aria-label^="拖动节点："]');
    const dragTo=await run(function(destination){
      if(destination==='library'){
        const r=document.querySelector('[data-preset-list]').getBoundingClientRect();
        const last=[...document.querySelectorAll('[data-custom-node]')].at(-1).getBoundingClientRect();
        return {x:(r.left+r.right)/2,y:Math.max(r.top+20,Math.min(r.bottom-20,(last.top+last.bottom)/2))};
      }
      const button=[...document.querySelectorAll('[data-preset-content] button')].find(element=>!element.closest('[data-custom-group]')&&element.textContent.includes('玩家设定'));
      if(!button)return null;
      const r=button.getBoundingClientRect();
      return {x:(r.left+r.right)/2,y:(r.top+r.bottom)/2};
    },destination);
    assert(dragTo,'Missing outside-drop destination: '+destination);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...dragFrom});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',...dragFrom,button:'left',buttons:1,clickCount:1});
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragFrom.x,y:dragFrom.y-14,buttons:1});
    await delay(40);
    assert(await evaluate('document.querySelector('+json(row(outsideId))+')?.dataset.dragging==="true"'),'Outside-drop regression must first activate a real drag');
    for(let step=1;step<=8;step++){
      await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:dragFrom.x+(dragTo.x-dragFrom.x)*step/8,y:dragFrom.y+(dragTo.y-dragFrom.y)*step/8,buttons:1});
      await delay(20);
    }
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',...dragTo,button:'left',buttons:0,clickCount:1});
    await delay(160);
    assert(json(await nodeOrder())===json(unchanged),'Dropping in '+destination+' must leave custom-node order unchanged');
    assert(await evaluate('!document.querySelector("[role=dialog]") && !document.querySelector("[data-custom-node][data-dragging=true]") && !document.querySelector("[data-custom-node][data-drop]")'),'Outside drop should clear drag state and must not activate the destination');
  }


  console.log('PASS: fractional-temperature saves, restored menu focus, keyboard drag cleanup, and first-node boundary drops into library/fixed-source areas.');

  // Drag the last row above its predecessor using actual pointer movement/capture.
  const orderBeforeDrag=await nodeOrder(),targetId=orderBeforeDrag.at(-2);
  await run(function(id){
    document.querySelector('[data-custom-node="'+id+'"]').scrollIntoView({block:'center',behavior:'instant'});
  },targetId);
  const from=await point(handle);
  const target=await run(function(id){
    const r=document.querySelector('[data-custom-node="'+id+'"]').getBoundingClientRect();
    return {x:r.left+20,y:r.top+Math.min(12,r.height/4)};
  },targetId);
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...from});
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
  for(let step=1;step<=8;step++){
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x,y:from.y+(target.y-from.y)*step/8,buttons:1});
    await delay(25);
  }
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:from.x,y:target.y,button:'left',buttons:0,clickCount:1});
  await until('[...document.querySelectorAll("[data-custom-node]")].findIndex(row=>row.dataset.customNode==='+json(newId)+')<[...document.querySelectorAll("[data-custom-node]")].findIndex(row=>row.dataset.customNode==='+json(targetId)+')');
  assert(await evaluate('!document.querySelector("[role=dialog]")'),'Pointer drop should not also open the node editor');
  await pointerClick(row(newId)+' button[aria-label^="更多节点操作："]');
  await buttonText('删除节点',row(newId)+' [data-preset-menu]');
  await until('!!document.querySelector("[role=dialog]")');
  await buttonText('取消','[role="dialog"]');
  assert((await nodeOrder()).includes(newId),'Canceling deletion removed a custom node');
  await pointerClick(row(newId)+' button[aria-label^="更多节点操作："]');
  await buttonText('删除节点',row(newId)+' [data-preset-menu]');
  await buttonText('删除节点','[role="dialog"]');
  await until('!document.querySelector('+json(row(newId))+')');
  await save();

  await pointerClick('button[aria-label="新建预设"]');
  await until('document.querySelectorAll("[data-preset-item]").length===8');
  const createdId=await evaluate('document.querySelector("[data-preset-item][aria-pressed=true]").dataset.presetItem');
  assert(!initial.some(entry=>entry.id===createdId),'New preset should have a unique identity');
  await fill(fieldName,'回归新建预设');
  await fill(fieldDescription,'验证新建、保存与删除流程。');
  await save();
  await select(first.id);
  await select(createdId);
  assert(await evaluate('document.querySelector('+json(fieldName)+').value')==='回归新建预设','Switching away lost the newly saved preset');
  await pointerClick('button[aria-label="更多预设操作"]');
  await buttonText('删除预设','[data-preset-menu]');
  await buttonText('删除预设','[role="dialog"]');
  await until('document.querySelectorAll("[data-preset-item]").length===7 && !document.querySelector("[role=dialog]")');
  await select(first.id);
  await send('Page.reload');
  await until('!!document.querySelector("[data-preset-workspace]") && document.querySelector('+json(fieldName)+')?.value==='+json(originalName));
  assert(await evaluate('document.querySelectorAll("[data-preset-item]").length')===7,'Reload should restore static fixtures, not persist local test edits');
  console.log('PASS: presets use independent list/editor scrolling, two-line ellipsis, draft retention and save/revert, prompt guard/focus trap, real node switches, keyboard moves, pointer drag, and creation/deletion.');

  await viewport(1280,800);
  await open('/presets/'+ensemble.id);
  const desktop1280=await metrics();
  assert(desktop1280.content.left>=desktop1280.list.right-1&&desktop1280.content.width>=400,'1280px preset editor should retain a usable second column');
  assert(desktop1280.pageWidth<=1280,'1280px preset page has horizontal overflow');
  await screenshot('presets-desktop-1280');

  for(const [width,height,mobile] of [[768,1024,false],[390,844,true],[375,812,true]]){
    await viewport(width,height,mobile);
    await open();
    const listVisible=await run(function(){
      const element=document.querySelector('[data-preset-list]'),r=element.getBoundingClientRect();
      return r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth+1;
    });
    assert(listVisible,width+': narrow entry should present a usable preset list');
    await screenshot('presets-list-'+width);
    await select(first.id);
    const narrow=await metrics();
    assert(narrow.content&&narrow.content.width>=Math.min(300,width-48)&&narrow.content.right<=width+1&&narrow.pageWidth<=width,width+': editor should use the available pane without horizontal overflow: '+json(narrow));
    const back=await point('button[aria-label="返回预设列表"]');
    assert(back.x>0,width+': narrow detail requires a visible list return control');
    await screenshot('presets-editor-'+width);
    await pointerClick('button[aria-label="编辑叙事风格"]');
    await until('!!document.querySelector("[role=dialog] textarea")');
    await fill(prompt,longPrompt);
    await modalGeometry(String(width));
    await screenshot('presets-prompt-editor-'+width);
    await discardDialog();
    await pointerClick('button[aria-label="返回预设列表"]');
    await until('location.pathname==="/presets" && document.querySelector("[data-preset-workspace]")?.dataset.detail==="false" && document.querySelector("[data-preset-list]")?.getBoundingClientRect().width>0');
    assert(await run(function(){
      const r=document.querySelector('[data-preset-list]').getBoundingClientRect();
      return r.width>0&&r.left>=0&&r.right<=innerWidth+1;
    }),width+': returning from detail should restore the visible list');
  }
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await select(first.id);
  await pointerClick('button[aria-label="编辑叙事风格"]');
  await until('!!document.querySelector("[role=dialog]")');
  const reduced=await evaluate('parseFloat(getComputedStyle(document.querySelector("[role=dialog]")).transitionDuration)');
  assert(reduced<.001,'Reduced-motion editor dialog should not animate');
  await key('Escape');
  await until('!document.querySelector("[role=dialog]")');
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'},{name:'hover',value:'hover'},{name:'pointer',value:'fine'}]});
  console.log('PASS: preset workbench/editor dialogs at 1536, 1280, 768, 390 and 375px, plus reduced motion.');
}
