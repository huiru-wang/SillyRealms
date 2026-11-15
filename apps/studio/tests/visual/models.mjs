/** Runs against the disposable HTTP/SQLite browser fixture, never a user Provider. */
export async function checkModels({origin,call,evaluate,until,navigate,click,shot,assert,setTheme}){
 const request=async(path,method='GET',body)=>{
  const response=await fetch(origin+'/api/v1/'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const result=await response.json();assert(response.ok,'Model fixture request failed: '+path);return result.data;
 };
 const catalog=await request('providers/models');
 const {id:ignoredId,...preset}=(await request('presets/sr-default-preset')).item;
 for(const name of ['导航预设 A','导航预设 B'])await request('presets','POST',{...preset,name});
 const provider=catalog.providers.find(p=>p.models.length);
 const created=[];
 for(const name of ['A 模型配置','B 模型配置','C 模型配置'])created.push((await request('api-model-configs','POST',{name,providerId:provider.providerId,modelId:provider.models[0].id,apiKey:'browser-only'})).item);
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await navigate('/models?sidebar=expanded');
 await until('document.querySelectorAll("[data-model-shortcut]").length===2&&document.querySelectorAll("[data-model-item]").length>=4');
 await setTheme('light');await until('document.querySelectorAll("[data-model-shortcut]").length===2');
 await until('document.querySelectorAll("[data-session-shortcut]").length===2&&document.querySelectorAll("[data-preset-shortcut]").length===2');
 const expected=(await request('api-model-configs')).items.slice(0,2).map(item=>item.id);
 assert(JSON.stringify(await evaluate('[...document.querySelectorAll("[data-model-shortcut]")].map(e=>e.dataset.modelShortcut)'))===JSON.stringify(expected),'Model shortcut order');
 assert(await evaluate('(()=>{const l=document.querySelector("[aria-label=模型配置列表]").getBoundingClientRect(),d=document.querySelector("[aria-label=模型配置详情]").getBoundingClientRect();return l.width>0&&d.left>=l.right&&d.width>300})()'),'Desktop split layout');
 await shot('production-model-workspace-light-1280');
 await evaluate('document.querySelector("[data-model-shortcut]").click()');
 await until('document.querySelector("[data-model-shortcut][aria-current=page]")?.dataset.modelShortcut==='+JSON.stringify(expected[0]));
 await setTheme('dark');await shot('production-model-workspace-dark-1280');await setTheme('light');
 const target=created[0];
 await navigate('/models/'+target.id);await until('document.querySelector("[aria-label=模型配置详情] h2")?.textContent==='+JSON.stringify(target.name));
 await click('编辑连接');await until('!!document.querySelector("[role=dialog]")');
 await evaluate('(()=>{const input=document.querySelector("[role=dialog] input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"A 已更新连接");input.dispatchEvent(new Event("input",{bubbles:true}))})()');
 await click('保存模型');await until('!document.querySelector("[role=dialog]")&&document.querySelector("[data-model-shortcut]")?.textContent.includes("A 已更新连接")');
 assert((await request('api-model-configs/'+target.id)).item.credentialConfigured,'Editing with blank key discarded credential');
 await click('设为默认');await until('document.querySelector("[aria-label=模型配置详情]").textContent.includes("当前默认")');
 assert((await request('app-settings')).item.defaultApiModelConfigId===target.id,'Default model did not persist');
 await request('app-settings','PATCH',{defaultApiModelConfigId:'test-model'});
 await call('Emulation.setDeviceMetricsOverride',{width:375,height:850,deviceScaleFactor:1,mobile:true});
 await navigate('/models');await until('document.querySelectorAll("[data-model-item]").length>=4');
 assert(await evaluate('getComputedStyle(document.querySelector("[aria-label=模型配置详情]")).display==="none"&&!!document.querySelector("nav[aria-label=手机主导航]")'),'Mobile list navigation');
 await shot('production-model-list-375');
 await evaluate('document.querySelector("[data-model-item]").click()');await until('document.querySelector("[data-model-workspace]")?.dataset.detail==="true"');
 assert(await evaluate('document.documentElement.scrollWidth<=innerWidth&&getComputedStyle(document.querySelector("[aria-label=模型配置列表]")).display==="none"&&!document.querySelector("nav[aria-label=手机主导航]")'),'Mobile detail layout/navigation');
 await shot('production-model-detail-375');
 await click('删除连接');await click('取消');assert(!!(await request('api-model-configs/'+target.id)).item,'Cancel deleted model');
 await click('删除连接');await click('确认删除');await until('location.pathname==="/models"&&!document.querySelector("[role=dialog]")');
 assert(!(await request('api-model-configs')).items.some(item=>item.id===target.id),'Delete did not persist');
 await until('!document.querySelector('+JSON.stringify('[data-model-shortcut="'+target.id+'"]')+')');
 await navigate('/models/missing-model');await until('document.body.innerText.includes("模型配置不存在")');
 await click('添加模型');await click('保存模型');await until('document.querySelector("[role=dialog]")?.textContent.includes("请补齐")');await click('取消');
 console.log('PASS: two sidebar shortcuts per section, model split layout, shortcut routing, credential-preserving edit, default/delete/cancel/validation, light/dark and 1280/375');
}
