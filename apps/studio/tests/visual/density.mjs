export async function checkDensity({call,evaluate,until,navigate,click,shot,assert,pointer,key,frameUntil}){
 const patch=async(path,body)=>assert(await evaluate('(async()=>{const r=await fetch('+JSON.stringify('/api/v1/'+path)+',{method:"PATCH",headers:{"content-type":"application/json"},body:'+JSON.stringify(JSON.stringify(body))+'});return r.ok})()'),'Fixture update failed');
 const choose=async(label)=>{await until('document.querySelector('+JSON.stringify('[role=combobox][aria-label="'+label+'"]')+')?.disabled===false');await pointer('[role=combobox][aria-label="'+label+'"]');await until('!!document.querySelector("[role=listbox]")');await key('End');await key('Enter');await until('!document.querySelector("[role=listbox]")');};
 const assertRequired=async(labels)=>{
  for(const label of labels){
   await until('document.querySelector('+JSON.stringify('[role=combobox][aria-label="'+label+'"]')+')?.disabled===false');
   assert(await evaluate('(()=>{const s=document.querySelector('+JSON.stringify('[role=combobox][aria-label="'+label+'"]')+').closest("[data-select-root]").querySelector("select");return s&&[...s.options].every(o=>o.value!==""||o.disabled)})()'),'Selectable empty option: '+label);
   await pointer('[role=combobox][aria-label="'+label+'"]');await until('!!document.querySelector("[role=listbox]")');
   assert(await evaluate('!document.querySelector("[role=listbox]").innerText.includes("未配置")&&document.querySelector("[role=listbox] [role=option]").getAttribute("aria-disabled")==="true"'),'Blank choice is selectable');
   await key('Home');assert(await evaluate('document.querySelector("[role=listbox] [data-active=true]").getAttribute("aria-disabled")!=="true"'),'Keyboard selected placeholder');await key('Escape');
  }
 };
 for(const width of [1280,375,320]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:width<500});
  await navigate('/worlds/browser-world');await frameUntil('document.querySelector("[data-state-check]")?.dataset.stateCheck==="state-safe"','iframe[data-world-component]');
  for(const compact of [false,true]){
   if(compact){await click('收起世界概览');await until('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)>.99');}
   const metrics=await evaluate('(()=>{const strip=document.querySelector("[data-role-strip='+(compact?'compact':'expanded')+']"),button=strip.querySelector("[data-role-action=select]"),r=button.getBoundingClientRect(),profile=button.previousElementSibling.getBoundingClientRect(),overview=document.querySelector("[data-world-overview]").getBoundingClientRect();return {height:r.height,gap:r.top-profile.bottom,bottom:r.bottom,overview:overview.bottom}})()');
   assert(metrics.height>=24&&metrics.height<=28&&metrics.gap<=4&&metrics.bottom<=metrics.overview,'Role spacing/clipping: '+JSON.stringify(metrics));
   await shot('density-roles-'+(compact?'compact':'expanded')+'-'+width);
  }
  await click('开局');await frameUntil('!!document.querySelector("[data-opening-preview]")','iframe[data-world-component]');
  assert(await evaluate('(()=>{const prev=document.querySelector("[aria-label=上一个开局]"),next=document.querySelector("[aria-label=下一个开局]"),buttons=[prev,next,...[...document.querySelectorAll("[data-world-content] button")].filter(e=>["查看初始状态","开始会话"].includes(e.textContent))],rects=[...buttons,prev.parentElement.querySelector("span")].map(e=>e.getBoundingClientRect());return rects.length===5&&rects.every(r=>Math.abs((r.top+r.bottom)/2-(rects[0].top+rects[0].bottom)/2)<2&&r.left>=0&&r.right<=innerWidth)&&document.documentElement.scrollWidth<=innerWidth})()'),'Opening controls do not fit a single row at '+width);
  await shot('density-opening-'+width);await click('下一个开局');await frameUntil('!!document.querySelector("[data-second-preview]")','iframe[data-world-component]');await click('上一个开局');
  await click('运行配置');await until('document.querySelectorAll("[data-world-content] [role=combobox]").length===2');await assertRequired(['预设','模型']);
  await navigate('/settings');await until('document.querySelectorAll(".settings-row [role=combobox]").length===3');await assertRequired(['默认预设','默认模型']);await shot('density-settings-'+width);
  if(width<500)assert(await evaluate('[...document.querySelectorAll("nav[aria-label=手机主导航] a")].map(e=>e.textContent).join(",")==="世界卡,预设,会话,模型,设置"'),'Mobile navigation order');
  else assert(await evaluate('[...document.querySelectorAll("aside section h2 a")].map(e=>e.textContent).join(",")==="会话列表,预设列表,模型列表"'),'Desktop navigation order changed');
 }
 // Existing unconfigured records must require a deliberate selection before saving.
 await patch('app-settings',{defaultPresetId:null,defaultApiModelConfigId:null});
 await navigate('/settings');await until('document.querySelectorAll(".settings-row [role=combobox]").length===3');
 assert(await evaluate('document.querySelector(".settings-row-action button").disabled'),'Empty defaults can be saved');
 await choose('默认预设');assert(await evaluate('document.querySelector(".settings-row-action button").disabled'),'Partial defaults can be saved');await choose('默认模型');await click('保存默认配置');await until('document.body.innerText.includes("默认配置已保存")');
 await patch('worlds/browser-world',{defaultPresetId:null,defaultApiModelConfigId:null});
 await navigate('/worlds/browser-world');await until('!!document.querySelector("[data-world-section=运行配置]")');await click('运行配置');await until('document.querySelectorAll("[role=combobox]").length===2');
 assert(await evaluate('[...document.querySelectorAll("button")].find(e=>e.textContent==="保存配置").disabled'),'Empty world configuration can be saved');
 await choose('预设');await choose('模型');await click('保存配置');await until('document.body.innerText.includes("运行配置已保存")');
 assert(await evaluate('(async()=>{const defaults=(await(await fetch("/api/v1/app-settings")).json()).data.item,world=(await(await fetch("/api/v1/worlds/browser-world")).json()).data.item;return !!defaults.defaultPresetId&&!!defaults.defaultApiModelConfigId&&!!world.defaultPresetId&&!!world.defaultApiModelConfigId})()'),'Valid selections were not persisted');
 console.log('PASS: compact roles/headers, single-row opening at 1280/375/320, required configuration choices and save guards, mobile-only navigation reorder');
}
