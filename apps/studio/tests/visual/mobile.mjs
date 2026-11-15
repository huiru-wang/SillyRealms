/** Non-loopback HTTP reproduces phone LAN capabilities; viewport emulation alone does not. */
export async function checkMobile({call,evaluate,until,navigate,click,shot,assert,frameUntil,manifest,exceptions}){
 await call('Emulation.setDeviceMetricsOverride',{width:375,height:850,deviceScaleFactor:1,mobile:true});
 await navigate('/worlds/browser-world');
 assert(await evaluate('!isSecureContext&&typeof crypto.randomUUID==="undefined"&&typeof crypto.getRandomValues==="function"'),'Test is not ordinary LAN HTTP');
 await until('!!document.querySelector("[data-world-component]")||!document.getElementById("main-content")');
 assert(!exceptions.some(e=>e.includes('randomUUID')),'LAN world detail crashes: '+exceptions.join('\n'));
 await frameUntil('document.querySelector("[data-state-check]")?.dataset.stateCheck==="state-safe"','iframe[data-world-component]');
 await shot('mobile-lan-world-introduction-375');
 const snapshots={};
 for(const width of [1280,375]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<500});
  await navigate('/worlds/browser-world');
  await frameUntil('document.querySelector("[data-state-check]")?.dataset.stateCheck==="state-safe"','iframe[data-world-component]');
  snapshots[width]={sections:await evaluate('[...document.querySelectorAll("[data-world-section]")].map(e=>e.textContent)')};
  assert(snapshots[width].sections.length===6,'World section missing at '+width);
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'World detail overflows '+width);
  await click('收起世界概览');await until('Number(document.querySelector("[data-collapse-progress]").dataset.collapseProgress)>.99');
  await shot('mobile-audit-world-compact-'+width);
  await click('世界书');await until('document.querySelector("[data-world-content]").textContent.includes("长街的历史")');
  await shot('mobile-audit-lore-'+width);
  await click('世界状态');await until('document.querySelector("[data-world-content]").textContent.includes("weather")');
  await shot('mobile-audit-world-state-'+width);
  await click('运行配置');await until('document.querySelectorAll("[data-world-content] [role=combobox]").length===2');
  assert(await evaluate('(()=>{const tab=document.querySelector("[data-world-section=运行配置]").getBoundingClientRect(),strip=document.querySelector("[aria-label=世界详情章节]").getBoundingClientRect();return tab.left>=strip.left-1&&tab.right<=strip.right+1})()'),'Active chapter is outside visible strip');
  await shot('mobile-audit-world-config-'+width);
  await click('会话');await until('!!document.querySelector("[data-session-row]")');
  await shot('mobile-audit-world-sessions-'+width);
  await click('开局');await frameUntil('!!document.querySelector("[data-opening-preview]")&&document.querySelector("[data-state-check]")?.dataset.stateCheck==="state-safe"','iframe[data-world-component]');
  await click('查看初始状态');await until('!!document.querySelector("[role=dialog]")');await shot('mobile-audit-opening-state-'+width);await click('关闭弹窗');await until('!document.querySelector("[role=dialog]")');
  await click('开始会话');await until('!!document.querySelector("[role=dialog]")');
  assert(await evaluate('document.querySelector("[role=dialog]").textContent.includes("旅人")&&document.querySelector("[role=dialog]").textContent.includes("灯火初上")'),'Opening/role confirmation missing');
  await shot('mobile-audit-start-'+width);await click('取消');await until('!document.querySelector("[role=dialog]")');
  await navigate('/settings');await until('document.querySelectorAll(".settings-row [role=combobox]").length===3');
  snapshots[width].settings=await evaluate('[...document.querySelectorAll(".settings-row [role=combobox]")].map(e=>e.getAttribute("aria-label"))');
  await shot('mobile-audit-settings-'+width);
  if(width<500){
   const links=await evaluate('[...document.querySelectorAll("nav[aria-label=手机主导航] a")].map(e=>({text:e.textContent,width:e.getBoundingClientRect().width}))');
   assert(links.map(e=>e.text).join(',')==='世界卡,预设,会话,模型,设置'&&links.every(e=>e.width>=44),'Mobile primary destinations/targets incorrect');
   await evaluate('document.getElementById("main-content").scrollTo(0,100000)');
   assert(await evaluate('document.querySelector(".settings-row-action button").getBoundingClientRect().bottom<=document.querySelector("nav[aria-label=手机主导航]").getBoundingClientRect().top'),'Settings save hidden behind navigation');
   await shot('mobile-audit-settings-bottom-'+width);
   await evaluate('document.querySelector("nav[aria-label=手机主导航] a[href=\'/models\']").click()');await until('location.pathname==="/models"');
  }else await navigate('/models');
  await until('!!document.querySelector("[data-model-item]")');await shot('mobile-audit-models-'+width);
  await evaluate('document.querySelector("[data-model-item]").click()');await until('document.querySelector("[data-model-workspace]")?.dataset.detail==="true"');
  assert(await evaluate('getComputedStyle(document.querySelector("[aria-label=模型配置详情]")).display!=="none"'),'Model detail inaccessible');
  await shot('mobile-audit-model-detail-'+width);
  await navigate('/presets/sr-default-preset');await until('!!document.querySelector("[aria-label=预设名称]")');
  snapshots[width].presetFields=await evaluate('[...document.querySelectorAll("input[aria-label]")].map(e=>e.getAttribute("aria-label"))');
  await shot('mobile-audit-preset-detail-'+width);
  await navigate('/sessions');await until('!!document.querySelector("[data-session-row]")');await shot('mobile-audit-sessions-'+width);
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'Session list overflow');
 }
 assert(JSON.stringify(snapshots[1280])===JSON.stringify(snapshots[375]),'Desktop/mobile controls differ: '+JSON.stringify(snapshots));
 // A full LAN journey: opening -> confirmation -> persisted session -> isolated story.
 await navigate('/worlds/browser-world');await frameUntil('document.querySelector("[data-state-check]")?.dataset.stateCheck==="state-safe"','iframe[data-world-component]');
 await click('开局');await frameUntil('!!document.querySelector("[data-opening-preview]")','iframe[data-world-component]');
 await click('开始会话');await click('确认开始');await until('location.pathname.startsWith("/sessions/")');
 await frameUntil('document.body.innerText.includes("暮色落下")');await until('!!document.querySelector("[contenteditable]")');
 assert(await evaluate('document.querySelector("header h1")?.textContent==="灯火初上"'),'LAN session title lost');await shot('mobile-lan-session-375');
 await call('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true});
 await navigate('/settings');await until('document.querySelectorAll(".settings-row [role=combobox]").length===3');
 assert(await evaluate('document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll("nav[aria-label=手机主导航] a")].every(e=>e.getBoundingClientRect().width>=44)'),'320px navigation overflow/targets');await shot('mobile-audit-settings-320');
 console.log('PASS: LAN HTTP introduction/opening/state/confirmation/session, readonly isolation, desktop/mobile world/settings/preset parity, models/settings navigation, 1280/375/320');
}
