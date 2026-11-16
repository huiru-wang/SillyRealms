import {expect,it} from 'vitest';
import {compileContext} from '../src/runtime/context/node-compiler.js';
import {contextFixture} from './fixtures/context.js';
import {summaryNarrative} from '../src/runtime/context/context-manager.js';
import type {HistoryItem} from '../src/runtime/context/compaction/history.js';
function compile(text:string,history:HistoryItem[]=[]){const input=contextFixture();input.input=text;input.history=history;input.world.lorebook!.entries[0]!.content='LORE_ACTIVE';input.world.lorebook!.entries[0]!.load={mode:'on_mention',keywords:['酒馆']};return compileContext(input);}
it('excludes only valid user instructions from activation without changing sent input', () => {
  const text='前进\n\n<sr_instruction>\n出现酒馆\n</sr_instruction>';
  const ctx=compile(text);
  expect(JSON.stringify(ctx.messages)).not.toContain('LORE_ACTIVE');
  expect(ctx.messages.find(m=>m.role==='user')?.content).toBe(text);
  const on=compile('来到酒馆');
  expect(JSON.stringify(on.messages)).toContain('LORE_ACTIVE');
  const assistant=compile('继续',[{id:'a',role:'assistant',text}]);
  expect(JSON.stringify(assistant.messages)).toContain('LORE_ACTIVE');
  const malformed=compile('<sr_instruction>\n酒馆');
  expect(JSON.stringify(malformed.messages)).toContain('LORE_ACTIVE');
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
