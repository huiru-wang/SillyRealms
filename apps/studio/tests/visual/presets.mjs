/** Preset workbench regression against disposable HTTP/SQLite; never a user Provider. */
export async function checkPresets({origin,call,evaluate,until,navigate,click,shot,assert,pointer,key,setTheme}){
 const q=JSON.stringify;
 const request=async(path,method='GET',body,headers={})=>{
  const response=await fetch(origin+'/api/v1/'+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();
  assert(response.ok,'Preset fixture request failed: '+method+' '+path+' '+response.status+' '+JSON.stringify(result));
  return Object.hasOwn(result,'data') ? result.data : result;
 };
 const field=async(label,value)=>{
  await evaluate('(()=>{const e=document.querySelector('+q('[aria-label="'+label+'"]')+');if(!e)throw Error("Missing field");const prototype=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,"value").set.call(e,'+q(String(value))+');e.dispatchEvent(new Event("input",{bubbles:true}))})()');
 };
 const ready=async(id)=>{
  await until('location.pathname==='+q('/presets/'+id)+'&&document.querySelectorAll("[data-preset-section]").length===4&&!!document.querySelector("[aria-label=温度]")');
 };
 const currentParameters=()=>evaluate('({temperature:Number(document.querySelector("[aria-label=温度]").value),thinking:document.querySelector("[aria-label=开启深度思考]").getAttribute("aria-checked")==="true"})');
 const assertParameters=async(temperature,thinking,message)=>{
  const actual=await currentParameters();
  assert(actual.temperature===temperature&&actual.thinking===thinking,message+': '+JSON.stringify(actual));
 };
 const save=async()=>{
  await until('document.querySelector("[aria-label=保存预设]")?.disabled===false');
  await click('保存预设');
  await until('document.querySelector("[data-dirty]")?.dataset.dirty==="false"&&document.querySelector("[aria-label=保存预设]")?.disabled===true');
  assert(await evaluate('!document.querySelector("[data-preset-content] [role=alert]")'),'Saving preset left an error');
 };
 const selectSection=async(section)=>{
  await evaluate('(()=>{const pane=document.querySelector("[data-preset-content]"),section=document.querySelector('+q('[data-preset-section="'+section+'"]')+');pane.scrollTop+=section.getBoundingClientRect().top-pane.getBoundingClientRect().top})()');
 };
 const order=()=>evaluate('[...document.querySelectorAll("[data-custom-node]")].map(e=>e.dataset.customNode)');
 const waitOrder=ids=>until('JSON.stringify([...document.querySelectorAll("[data-custom-node]")].map(e=>e.dataset.customNode))==='+q(JSON.stringify(ids)));
 const waitForVisibleSaveError=()=>until('(()=>{const pane=document.querySelector("[data-preset-content]"),alert=pane?.querySelector("[role=alert]");if(!alert)return false;const p=pane.getBoundingClientRect(),r=alert.getBoundingClientRect();return r.height>0&&r.top>=p.top-1&&r.bottom<=p.bottom+1&&r.top>=0&&r.bottom<=innerHeight&&!document.querySelector("[data-preset-workspace] > [aria-hidden=true]")&&document.querySelector("[aria-label=保存预设]")?.disabled===false})()');
 const noDialog=()=>until('!document.querySelector("[role=dialog]")');
 const editNode=id=>'[data-custom-node="'+id+'"] button[aria-label^="编辑节点："]';
 const dragNode=id=>'[data-custom-node="'+id+'"] button[aria-label^="拖动节点："]';
 const toggle='[role=switch][aria-label="开启深度思考"]';
 const defaults=await request('presets/default');
 const nodeA={id:'browser-preset-a',name:'场景细节与叙事节奏',kind:'text',role:'system',enabled:true,prompt:{parts:[{type:'text',value:'保持场景连续性，使用清晰的动作和空间描写。'}]}};
 const nodeB={id:'browser-preset-b',name:'角色对白与情绪变化的补充规则'.repeat(4),kind:'text',role:'assistant',enabled:true,prompt:{parts:[{type:'text',value:'用角色的语言习惯与行为表现情绪变化。'}]}};
 const config=structuredClone(defaults);
 config.name='预设界面验证';
 config.description='用于检查参数保存、提示词排序与手机布局。';
 config.model_parameters={...config.model_parameters,temperature:1,thinking_enabled:false};
 config.config_json.nodes.splice(1,0,nodeA,nodeB);
 const created=(await request('presets','POST',config)).item;
 const alternate=(await request('presets','POST',{...defaults,name:'草稿切换验证'})).item;
 const presetPath='presets/'+encodeURIComponent(created.id);
 const route='/presets/'+encodeURIComponent(created.id);

 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await navigate(route+'?sidebar=expanded');await ready(created.id);
 await setTheme('light');await ready(created.id);
 assert(await evaluate('[...document.querySelectorAll("[data-preset-section]")].map(e=>e.dataset.presetSection).join(",")==="basic,model,context,nodes"'),'Preset sections changed');
 assert(await evaluate('!document.body.innerText.includes("高级设置")&&document.querySelector("[aria-label=温度]").closest("[data-preset-section]").dataset.presetSection==="model"'),'Model parameters are hidden or misplaced');
 await assertParameters(1,false,'Initial parameters');

 // Use the editor to save both model parameters, then reload and inspect portable data.
 await field('温度',.85);await pointer(toggle);await save();
 await navigate(route);await ready(created.id);await assertParameters(.85,true,'Parameters after reload');
 let persisted=(await request(presetPath)).item;
 assert(persisted.model_parameters.temperature===.85&&persisted.model_parameters.thinking_enabled===true,'Saved parameters did not reach SQLite');
 const exported=await request(presetPath+'/export');
 assert(exported.model_parameters.temperature===.85&&exported.model_parameters.thinking_enabled===true,'Export dropped model parameters');
 const imported=(await request('presets/import','POST',exported)).item;
 assert(imported.model_parameters.temperature===.85&&imported.model_parameters.thinking_enabled===true,'Import dropped model parameters');
 await click('更多预设操作');await click('复制预设');
 await until('location.pathname.startsWith("/presets/")&&location.pathname!=='+q(route)+'&&document.querySelector("[data-dirty]")?.dataset.dirty==="false"');
 const duplicateId=await evaluate('decodeURIComponent(location.pathname.split("/").at(-1))');
 const duplicate=(await request('presets/'+encodeURIComponent(duplicateId))).item;
 assert(duplicate.id!==created.id&&duplicate.model_parameters.temperature===.85&&duplicate.model_parameters.thinking_enabled===true,'Duplicate dropped model parameters');
 assert(duplicate.config_json.nodes.filter(n=>n.kind==='text').map(n=>n.id).join(',')===[nodeA.id,nodeB.id].join(','),'Duplicate changed custom node order');
 await navigate(route);await ready(created.id);
 await pointer(toggle);await save();
 assert((await request(presetPath)).item.model_parameters.thinking_enabled===false,'Disabled thinking did not persist');

 // Applying a prompt and switching selected presets must preserve the same in-memory draft.
 await field('温度',.65);await pointer(toggle);
 await pointer('[aria-label="编辑叙事风格"]');
 await until('!!document.querySelector("[role=dialog] textarea[aria-label=提示词正文]")');
 const originalMain=await evaluate('document.querySelector("[role=dialog] textarea").value');
 const editedMain=originalMain+'\n让场景变化与角色行动保持连续。';
 await field('提示词正文',editedMain);await click('应用');await noDialog();
 await assertParameters(.65,true,'Applying prompt lost parameter draft');
 await pointer('[data-preset-item="'+alternate.id+'"]');await ready(alternate.id);
 await pointer('[data-preset-item="'+created.id+'"]');await ready(created.id);
 await assertParameters(.65,true,'Switching presets lost parameter draft');
 await pointer('[aria-label="编辑叙事风格"]');await until('!!document.querySelector("[role=dialog] textarea")');
 assert(await evaluate('document.querySelector("[role=dialog] textarea").value==='+q(editedMain)),'Switching presets lost prompt draft');
 await key('Escape');await noDialog();
 assert(await evaluate('document.activeElement?.getAttribute("aria-label")==="编辑叙事风格"'),'Prompt dialog did not restore focus');
 await save();
 persisted=(await request(presetPath)).item;
 assert(persisted.config_json.nodes[0].prompt.parts[0].value===editedMain,'Applied prompt was not saved');

 // Discarding an unapplied editor change must leave the preset intact and return focus.
 await pointer(editNode(nodeA.id));await until('!!document.querySelector("[role=dialog] textarea")');
 await field('提示词正文','这段未应用的草稿应被取消。');
 await click('取消');await until('document.querySelector("[role=dialog]")?.textContent.includes("确定放弃")');
 await click('继续编辑');
 assert(await evaluate('document.querySelector("[role=dialog] textarea").value==="这段未应用的草稿应被取消。"'),'Cancel confirmation discarded edits too early');
 await click('取消');await click('放弃修改');await noDialog();
 assert(await evaluate('document.activeElement?.getAttribute("aria-label")==='+q('编辑节点：'+nodeA.name)),'Discard did not restore node focus');
 await pointer(editNode(nodeA.id));await until('!!document.querySelector("[role=dialog] textarea")');
 assert(await evaluate('document.querySelector("[role=dialog] textarea").value==='+q(nodeA.prompt.parts[0].value)),'Discarded prompt changed the draft');
 await key('Escape');await noDialog();

 // Keep keyboard ordering and real pointer drag/cancel behavior after removing visual nesting.
 await evaluate('document.querySelector('+q(dragNode(nodeA.id))+').focus()');await key('ArrowDown');await waitOrder([nodeB.id,nodeA.id]);
 await key('ArrowUp');await waitOrder([nodeA.id,nodeB.id]);
 const drag=async(id,targetId,outside=false)=>{
  await evaluate('document.querySelector("[data-custom-group]").scrollIntoView({block:"center"})');
  const points=await evaluate('(()=>{const handle=document.querySelector('+q(dragNode(id))+').getBoundingClientRect(),target=document.querySelector('+q('[data-custom-node="'+targetId+'"]')+').getBoundingClientRect(),group=document.querySelector("[data-custom-group]").getBoundingClientRect();return {from:{x:handle.left+handle.width/2,y:handle.top+handle.height/2},to:{x:'+(outside?'group.left-20':'handle.left+handle.width/2')+',y:'+(outside?'handle.top+handle.height/2+12':'target.bottom-5')+'}}})()');
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...points.from});
  await call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...points.from});
  for(let step=1;step<=8;step++)await call('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:points.from.x+(points.to.x-points.from.x)*step/8,y:points.from.y+(points.to.y-points.from.y)*step/8});
  await call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...points.to});
  await until('!document.querySelector("[data-dragging=true]")&&!document.querySelector("[data-drop]")');
 };
 await drag(nodeA.id,nodeB.id);await waitOrder([nodeB.id,nodeA.id]);
 const beforeCancel=await order();
 await drag(nodeB.id,nodeA.id,true);
 assert(JSON.stringify(await order())===JSON.stringify(beforeCancel),'Releasing outside custom area reordered nodes');
 await save();
 assert((await request(presetPath)).item.config_json.nodes.filter(n=>n.kind==='text').map(n=>n.id).join(',')===[nodeB.id,nodeA.id].join(','),'Drag order did not persist');

 // A real ETag conflict must keep local fields and prompts, rather than treating failure as saved.
 await field('温度',1.15);await pointer(toggle);
 persisted=(await request(presetPath)).item;
 await request(presetPath,'PATCH',{description:'外部修改后的描述'},{'If-Match':persisted.etag});
 await selectSection('nodes');
 await click('保存预设');
 await waitForVisibleSaveError();
 await assertParameters(1.15,false,'Save conflict discarded local parameter draft');
 assert(await evaluate('document.querySelector("[data-dirty]")?.dataset.dirty==="true"'),'Failed save marked the draft clean');
 persisted=(await request(presetPath)).item;
 assert(persisted.model_parameters.temperature===.65&&persisted.model_parameters.thinking_enabled===true&&persisted.description==='外部修改后的描述','Failed save overwrote server state');
 await shot('preset-redesign-save-conflict-1280');
 await click('更多预设操作');await click('放弃更改');
 await until('document.querySelector("[data-dirty]")?.dataset.dirty==="false"');
 await navigate(route);await ready(created.id);await assertParameters(.65,true,'Reload after conflict');

 // Inspect real geometry, long titles and action targets at all supported widths.
 for(const width of [1280,768,375,320]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:width===1280?900:850,deviceScaleFactor:1,mobile:width<500});
  await setTheme(width<500?'dark':'light');await ready(created.id);
  await evaluate('document.querySelector("[data-preset-content]").scrollTop=0');
  const metrics=await evaluate('(()=>{const nodes=[...document.querySelectorAll("[data-preset-node]")],rows=nodes.map(n=>{const r=n.getBoundingClientRect(),title=n.children[1].getBoundingClientRect();return {id:n.dataset.presetNode,left:r.left,right:r.right,title:title.left,scroll:n.scrollWidth,width:n.clientWidth}}),group=document.querySelector("[data-custom-group]"),s=getComputedStyle(group),buttons=[...document.querySelectorAll("[data-preset-node] button,[data-preset-section=model] button")].map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute("aria-label"),w:r.width,h:r.height,left:r.left,right:r.right}}),long=document.querySelector('+q('[data-custom-node="'+nodeB.id+'"]')+').children[1].querySelector("span"),titleStyle=getComputedStyle(long);return {rows,buttons,overflow:document.documentElement.scrollWidth-innerWidth,group:{margin:parseFloat(s.marginLeft),padding:parseFloat(s.paddingLeft),border:parseFloat(s.borderLeftWidth),height:group.getBoundingClientRect().height},title:{ellipsis:titleStyle.textOverflow,whiteSpace:titleStyle.whiteSpace,scroll:long.scrollWidth,width:long.clientWidth}}})()');
  assert(metrics.overflow<=1,'Document overflows at '+width+': '+JSON.stringify(metrics));
  assert(metrics.rows.length===10&&metrics.rows.every(r=>Math.abs(r.left-metrics.rows[0].left)<1&&Math.abs(r.right-metrics.rows[0].right)<1&&Math.abs(r.title-metrics.rows[0].title)<1&&r.scroll<=r.width+1&&r.left>=0&&r.right<=width+1),'Node edges or title alignment at '+width+': '+JSON.stringify(metrics.rows));
  assert(metrics.group.margin===0&&metrics.group.padding===0&&metrics.group.border===0&&metrics.group.height>0,'Custom group is indented or has no drag bounds');
  assert(metrics.title.ellipsis==='ellipsis'&&metrics.title.whiteSpace==='nowrap','Long node title no longer truncates');
  if(width<500){
   assert(metrics.title.scroll>metrics.title.width,'Long mobile title does not exercise truncation');
   assert(metrics.buttons.every(b=>b.w>=43.5&&b.h>=43.5&&b.left>=0&&b.right<=width+1),'Mobile action target is too small or clipped at '+width+': '+JSON.stringify(metrics.buttons));
   assert(await evaluate('!document.querySelector("nav[aria-label=手机主导航]")'),'Mobile preset detail shows bottom navigation');
  }
  assert(await evaluate('!document.body.innerText.includes("高级设置")'),'Advanced settings returned');
  await shot('preset-redesign-top-'+width);
  if(width===1280||width===375){
   await selectSection('context');await shot('preset-redesign-context-'+width);
   await selectSection('nodes');await shot('preset-redesign-nodes-'+width);
  }
 }

 // Reduced motion must leave the same controls visible and keyboard-operable.
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 await until('matchMedia("(prefers-reduced-motion: reduce)").matches');
 await selectSection('model');await pointer(toggle);
 await assertParameters(.65,false,'Reduced-motion switch click');
 await key(' ','Space');await assertParameters(.65,true,'Reduced-motion switch keyboard');
 // Respect the existing global reduced-motion policy of none or at most .01ms.
 assert(await evaluate('(()=>{const row=document.querySelector("[data-preset-node]"),track=document.querySelector("[aria-label=开启深度思考]").firstElementChild,seconds=value=>{const token=value.trim();return Number.parseFloat(token)/(token.endsWith("ms")?1000:1)};return [row,track,track.firstElementChild].every(e=>{const style=getComputedStyle(e);return style.transitionProperty==="none"||style.transitionDuration.split(",").every(t=>{const duration=seconds(t);return Number.isFinite(duration)&&duration<=.00001})})})()'),'Reduced motion retains node/switch transitions');
 await pointer('[aria-label="编辑叙事风格"]');await until('!!document.querySelector("[role=dialog] textarea")');await key('Escape');await noDialog();
 assert(await evaluate('document.activeElement?.getAttribute("aria-label")==="编辑叙事风格"'),'Reduced-motion modal focus');
 await call('Emulation.setEmulatedMedia',{features:[]});

 // A mobile save error must bring feedback into the editor, where the hidden list cannot help.
 await field('温度',1.05);
 const beforeMobileConflict=(await request(presetPath)).item;
 await request(presetPath,'PATCH',{description:'手机端外部修改后的描述'},{'If-Match':beforeMobileConflict.etag});
 await selectSection('nodes');
 assert(await evaluate('document.querySelector("[data-preset-content]").scrollTop>0'),'Mobile conflict did not start from the scrolled editor');
 await click('保存预设');await waitForVisibleSaveError();
 await assertParameters(1.05,true,'Mobile save conflict discarded parameter draft');
 assert(await evaluate('document.querySelector("[data-dirty]")?.dataset.dirty==="true"&&document.documentElement.scrollWidth<=innerWidth'),'Mobile conflict marked draft clean or overflowed');
 const afterMobileConflict=(await request(presetPath)).item;
 assert(JSON.stringify(afterMobileConflict.model_parameters)===JSON.stringify(beforeMobileConflict.model_parameters)&&afterMobileConflict.description==='手机端外部修改后的描述','Mobile conflict overwrote server state');
 await shot('preset-redesign-save-conflict-320');
 console.log('PASS: preset model parameters save/reload/export/import/duplicate/off; draft/apply/cancel and visible desktop/mobile ETag conflicts; keyboard/pointer order and outside cancel; flat nodes, 44px controls, long titles, light/dark, 1280/768/375/320 and reduced motion');
}
