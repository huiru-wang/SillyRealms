export async function checkSettings({call,evaluate,until,navigate,click,shot,assert,setTheme}){
 for(const width of [1280,375]){
  await call('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:width<500});
  await navigate('/settings');await until('document.querySelectorAll(".settings-row [role=combobox]").length===3');
  assert(await evaluate('!document.querySelector("aside [aria-label*=切换][aria-label*=主题]")&&!document.querySelector(".settings-page a")&&!document.querySelector(".about-note")&&!document.querySelector(".settings-page").innerText.includes("API Key 由本地服务端")'),'Removed settings/sidebar content remains');
  for(const theme of ['light','dark']){
   await setTheme(theme);
   assert(await evaluate('localStorage.getItem("sr-studio-theme")==='+JSON.stringify(theme)),'Theme was not persisted');
   assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'Settings horizontal overflow');
   await shot('production-settings-'+theme+'-'+width);
  }
  await call('Page.reload');await until('document.querySelector("[role=combobox][aria-label=主题]")?.innerText.includes("深色")');
  assert(await evaluate('document.documentElement.dataset.theme==="dark"'),'Reload lost theme');
  await navigate('/more');assert(await evaluate('!document.querySelector("[role=group][aria-label=主题]")'),'More duplicates theme setting');
  await click('应用设置');await until('location.pathname==="/settings"');
 }
 console.log('PASS: settings theme selection/persistence/reload, removed sidebar/More controls, removed model link/about card, light/dark 1280/375');
}
