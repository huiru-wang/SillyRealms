import { expect, it } from 'vitest';
import { contextTriggerThreshold } from '../src/agent/context/context-manager.js';

it('maps strategies to model-limited thresholds with output and input reserves', () => {
  expect(contextTriggerThreshold('compact', 1_000_000, 4096)).toBe(131_072 - 4096 - 1024 - 2048);
  expect(contextTriggerThreshold('standard', 1_000_000, 4096)).toBe(262_144 - 4096 - 1024 - 2048);
  expect(contextTriggerThreshold('extended', 1_000_000, 4096)).toBe(524_288 - 4096 - 1024 - 2048);
  expect(contextTriggerThreshold('extended', 32_768, 4096)).toBe(32_768 - 4096 - 1024 - 2048);
  expect(contextTriggerThreshold('compact', 1_000_000, 2048)).toBeGreaterThan(42_538);
});
import { buildContext } from '../src/agent/context/prompt-builder.js';
import { estimateContextComposition } from '../src/agent/context/context-manager.js';

it('uses literal content and freezes activation before history changes', () => {
  const world = { characters:[{id:'player',player_selectable:true,prompt:'{{user}}'},{id:'npc',prompt:'NPC',load:{mode:'on_mention',keywords:['forest']}}], lorebook:{entries:[{id:'entry',content:'LITERAL <% danger %>',load:{mode:'on_mention',keywords:['forest'],anchor:'characterInfo',position:'before'}}]} };
  const views = { global:{}, session:{}, message:{} };
  const nodes = [{id:'personaInfo',kind:'system' as const,role:'system' as const,enabled:true},{id:'characterInfo',kind:'system' as const,role:'system' as const,enabled:true},{id:'chatHistory',kind:'system' as const,role:'auto' as const,enabled:true},{id:'userInput',kind:'system' as const,role:'user' as const,enabled:true}];
  const context = buildContext(world,nodes,'player',views,[{role:'user',text:'forest'}],'hello');
  const messages = context.messages([]);
  expect(JSON.stringify(messages)).toContain('Default');
  expect(JSON.stringify(messages)).toContain('LITERAL <% danger %>');
  expect(JSON.stringify(messages)).toContain('NPC');
  expect(messages.filter(m => m.role === 'user')).toHaveLength(1);
});

it('builds the worldState node in preset order with active rules and current values',()=>{
  const world={characters:[{id:'p',name:'玩家',player_selectable:true}],state:{scopes:{
    global:{setting:{type:'json',initial:{year:42},description:'场景背景，仅供读取'}},
    message:{hero:{type:'json',initial:{hp:10,people:{}},description:'伤害后调整；people 存角色姓名'},hidden:{type:'json',initial:{secret:'hidden-value'},load:{mode:'on_mention',keywords:['never-match']}}}
  }}};
  const nodes=[{id:'main',kind:'system' as const,role:'system' as const,enabled:true,content:'起始指令'}, {id:'worldState',kind:'system' as const,role:'system' as const,enabled:true},{id:'userInput',kind:'system' as const,role:'user' as const,enabled:true}];
  const result=buildContext(world,nodes,'p',{global:{setting:{year:42}},session:{},message:{hero:{hp:7,people:{}},hidden:{secret:'hidden-value'}}},[],'继续');
  const output=result.messages([]);expect(output.map(m=>m.role)).toEqual(['system','system','system','user']);
  const text=String(output[2]?.content);expect(text).toContain('update_state');expect(text).toContain('【状态更新判断】');expect(text).toContain('【可更新状态】');expect(text).toContain('【只读状态】');expect(text).toContain('伤害后调整');expect(text).toContain('角色姓名');expect(text).toContain('hero（可更新；message；json）');expect(text).toContain('"hp":7');expect(text).toContain('"year":42');expect(text).not.toContain('hidden-value');
  const disabled=buildContext(world,nodes.map(n=>n.id==='worldState'?{...n,enabled:false}:n),'p',{global:{setting:{year:42}},session:{},message:{hero:{hp:7,people:{}},hidden:{secret:'hidden-value'}}},[],'继续');expect(disabled.messages([]).map(m=>m.role)).toEqual(['system','system','system','user']);
});


it('uses prompt only and applies load to the selected player',()=>{
  const nodes=[{id:'personaInfo',kind:'system' as const,role:'system' as const,enabled:true},{id:'characterInfo',kind:'system' as const,role:'system' as const,enabled:true}];
  const world={characters:[{id:'p',player_selectable:true,description:'PRIVATE DISPLAY',prompt:'PLAYER PROMPT',load:{mode:'never'}},{id:'n',description:'DISPLAY ONLY'},{id:'x',prompt:'NPC PROMPT'}]};
  const output=JSON.stringify(buildContext(world,nodes,'p',{global:{},session:{},message:{}},[],'').messages([]));
  expect(output).not.toContain('PRIVATE DISPLAY');expect(output).not.toContain('DISPLAY ONLY');expect(output).not.toContain('PLAYER PROMPT');expect(output).toContain('NPC PROMPT');
});

it('logs each dynamic load in one line only when debugging is enabled',async()=>{
  const {vi}=await import('vitest');
  const old=process.env.SILLYREALMS_DEBUG;
  const log=vi.spyOn(console,'log').mockImplementation(()=>{});
  try {
    process.env.SILLYREALMS_DEBUG='1';
    const world={characters:[{id:'p',player_selectable:true,prompt:'player',load:{mode:'never'}},{id:'npc',prompt:'npc',load:{mode:'on_mention',keywords:['forest'],when:'getState("hero.hp") > 0'}}],lorebook:{entries:[{id:'l',content:'lore',load:{mode:'always'}}]},state:{scopes:{message:{hero:{type:'json',initial:{hp:1},load:{mode:'never'}}}}}};
    buildContext(world,[],'p',{global:{},session:{},message:{hero:{hp:1}}},[],'forest');
    const lines=log.mock.calls.map(c=>String(c[0]));
    expect(lines).toHaveLength(4);
    expect(lines.every(line=>!line.includes('\n'))).toBe(true);
    expect(lines.some(line=>line.includes('角色')&&line.includes('关键词')&&line.includes('when=')&&line.includes('命中=是'))).toBe(true);
    expect(lines.some(line=>line.includes('世界书')&&line.includes('always'))).toBe(true);
    expect(lines.some(line=>line.includes('状态')&&line.includes('never')&&line.includes('命中=否'))).toBe(true);
    log.mockClear(); delete process.env.SILLYREALMS_DEBUG;
    buildContext(world,[],'p',{global:{},session:{},message:{hero:{hp:1}}},[],'forest');
    expect(log).not.toHaveBeenCalled();
  } finally { if(old===undefined)delete process.env.SILLYREALMS_DEBUG;else process.env.SILLYREALMS_DEBUG=old; log.mockRestore(); }
});


it('estimates context composition in system, summary, history order without claiming exact provider tokens',()=>{
  const world={characters:[{id:'p',name:'玩家',player_selectable:true}],lorebook:{entries:[]}};
  const nodes=[{id:'main',kind:'system' as const,role:'system' as const,enabled:true,content:'系统设定'},{id:'chatHistory',kind:'system' as const,role:'auto' as const,enabled:true},{id:'userInput',kind:'system' as const,role:'user' as const,enabled:true}];
  const context=buildContext(world,nodes,'p',{global:{},session:{},message:{}},[],'');
  const composition=estimateContextComposition(context,[
    {id:'summary',role:'assistant',text:'压缩摘要'},
    {id:'history-1',role:'user',text:'历史用户消息'},
    {id:'history-2',role:'assistant',text:'历史叙事'},
  ],'本轮输入');
  expect(composition.systemBytes).toBeGreaterThan(0);
  expect(composition.summaryBytes).toBeGreaterThan(0);
  expect(composition.historyBytes).toBeGreaterThan(composition.summaryBytes);
  expect(estimateContextComposition(context,[], '本轮输入').summaryBytes).toBe(0);
});
