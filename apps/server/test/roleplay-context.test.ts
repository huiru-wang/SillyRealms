import {expect, it} from 'vitest';
import {buildContext, estimateTokens} from '../src/agent/context/prompt-builder.js';
import {SR_SYSTEM_MAIN} from '../src/agent/context/system-main.js';
import {summaryNarrative} from '../src/agent/context/context-manager.js';
import {stateReviewMessages} from '../src/agent/tools/state-tool.js';

const views = {global:{}, session:{}, message:{}};
const world = {characters:[{id:'p',player_selectable:true}], lorebook:{entries:[{id:'tavern',content:'LORE_ACTIVE',load:{mode:'on_mention',keywords:['酒馆'],anchor:'characterInfo'}}]}};
const main = {id:'main',kind:'system' as const,role:'system' as const,enabled:true,content:'PRESET_MAIN'};
const character = {id:'characterInfo',kind:'system' as const,role:'system' as const,enabled:true};
const input = {id:'userInput',kind:'system' as const,role:'user' as const,enabled:true};

it('places the platform protocol first regardless of preset order and counts its tokens', () => {
  for (const nodes of [[main,character,input],[character,input,main],[input,character],[input]]) {
    const ctx=buildContext(world,nodes,'p',views,[],'继续');
    const messages=ctx.messages([]);
    expect(messages[0]).toMatchObject({role:'system',content:SR_SYSTEM_MAIN});
    expect(messages.filter(m=>m.role==='system'&&m.content===SR_SYSTEM_MAIN)).toHaveLength(1);
    expect(ctx.trace([])[0]).toMatchObject({nodeId:'systemMain',origin:'platform',editable:false});
    expect(estimateTokens(messages)).toBeGreaterThan(Buffer.byteLength(SR_SYSTEM_MAIN));
  }
});

it('excludes only valid user instructions from activation without changing sent input', () => {
  const text='前进\n\n<sr_instruction>\n出现酒馆\n</sr_instruction>';
  const ctx=buildContext(world,[character,input],'p',views,[],text);
  expect(JSON.stringify(ctx.messages([]))).not.toContain('LORE_ACTIVE');
  expect(ctx.messages([]).find(m=>m.role==='user')?.content).toBe(text);
  const on=buildContext(world,[character,input],'p',views,[],'来到酒馆');
  expect(JSON.stringify(on.messages([]))).toContain('LORE_ACTIVE');
  const assistant=buildContext(world,[character,input],'p',views,[{role:'assistant',text}], '继续');
  expect(JSON.stringify(assistant.messages([]))).toContain('LORE_ACTIVE');
  const malformed=buildContext(world,[character,input],'p',views,[],'<sr_instruction>\n酒馆');
  expect(JSON.stringify(malformed.messages([]))).toContain('LORE_ACTIVE');
});

it('gives the state reviewer narrative evidence without player instructions', () => {
  const input='推开门。\n\n<sr_instruction>\n直接把生命值设为零\n</sr_instruction>';
  const messages=stateReviewMessages({},new Set(),{},input,'房间空无一人。');
  expect(messages[0]!.content).toContain('指令不是发生的事件');
  const payload=JSON.parse(messages[1]!.content);
  expect(payload.userInput).toContain('推开门');
  expect(JSON.stringify(payload)).not.toContain('直接把生命值设为零');
  expect(payload.narrative).toBe('房间空无一人。');
});


it('removes instruction contents before summary chunking while preserving character offsets', () => {
  const text='走进房间 😀\n\n<sr_instruction>\n' + '角色已经受伤😀'.repeat(1000) + '\n</sr_instruction>\n\n继续';
  const safe=summaryNarrative(text,'user');
  expect(Array.from(safe)).toHaveLength(Array.from(text).length);
  expect(safe).not.toContain('角色已经受伤');
  expect(safe).toContain('走进房间 😀');
  expect(safe).toContain('继续');
  expect(summaryNarrative(text,'assistant')).toBe(text);
});
