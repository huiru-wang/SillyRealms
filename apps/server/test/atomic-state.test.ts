import { describe, expect, it } from 'vitest';
import { updateAtomicState, type AtomicStateDefinition } from '../src/domain/state/atomic-state.js';
import type { Json } from '../src/domain/state/state.js';

const defs: Record<string, AtomicStateDefinition> = {
  灵力: { type:'number', initial:5, min:0, max:10 },
  记录: { type:'json', initial:{} },
  姓名: { type:'string', initial:'绮罗香' },
};
describe('atomic state values',()=>{
  it('accepts fractions within bounds and rejects null and out-of-range values',()=>{
    const state: Record<string,Json> = { 灵力:5, 记录:{}, 姓名:'绮罗香' };
    expect(updateAtomicState(state,defs,'灵力',1.5)).toEqual({changed:true,value:1.5});
    expect(()=>updateAtomicState(state,defs,'灵力',11)).toThrow('STATE_OUT_OF_RANGE');
    expect(()=>updateAtomicState(state,defs,'姓名',null)).toThrow('INVALID_STATE_VALUE');
    expect(state.灵力).toBe(1.5);
  });
  it('overwrites nested json keys, reports no-op, and rejects missing parents and array indexing',()=>{
    const state: Record<string,Json> = { 灵力:5, 记录:{ 人物:{好感:1}, 列表:[1,2] }, 姓名:'绮罗香' };
    expect(updateAtomicState(state,defs,'记录.人物.好感',1).changed).toBe(false);
    expect(updateAtomicState(state,defs,'记录.人物.称号','社长').changed).toBe(true);
    expect(()=>updateAtomicState(state,defs,'记录.缺失.字段',1)).toThrow('INVALID_STATE_PATH');
    expect(()=>updateAtomicState(state,defs,'记录.列表.0',2)).toThrow('INVALID_STATE_PATH');
    expect(()=>updateAtomicState(state,defs,'记录',{ 'a.b':1 })).toThrow('INVALID_STATE_KEY');
    expect(state.记录).toEqual({人物:{好感:1,称号:'社长'},列表:[1,2]});
  });
});

it('initializes direct scope fields independently and validates complete snapshots', async()=>{
  const { initialAtomicState, validateAtomicSnapshot } = await import('../src/domain/state/atomic-state.js');
  const definitions: Record<string, AtomicStateDefinition> = { 进度:{type:'json',initial:{阶段:'日常'}}, 灵力:{type:'number',initial:5,min:0,max:10} };
  const first=initialAtomicState(definitions), second=initialAtomicState(definitions);
  updateAtomicState(first,definitions,'进度.阶段','导入');
  expect(second.进度).toEqual({阶段:'日常'});
  expect(()=>validateAtomicSnapshot(definitions,first)).not.toThrow();
  expect(()=>validateAtomicSnapshot(definitions,{灵力:1})).toThrow('STATE_SCHEMA_MISMATCH');
});

it('processes a batch in order even when a path does not exist', async()=>{
  const { applyAtomicUpdates } = await import('../src/domain/state/atomic-state.js');
  const values={ global:{}, session:{}, message:{灵力:5,记录:{},姓名:'绮罗香'} };
  const definitions={ global:{}, session:{}, message:defs };
  const output=applyAtomicUpdates(values,definitions,[{path:'灵力',value:2},{path:'不存在',value:1},{path:'灵力',value:3},{path:'灵力',value:3}]);
  expect(output.results.map(item=>item.success)).toEqual([true,false,true,true]);
  expect(output.results[1]).toMatchObject({path:'不存在',scope:'message',message:'STATE_NOT_FOUND'});
  expect(output.values.message.灵力).toBe(3);
  expect(output.changes.map(item=>item.value)).toEqual([3]);
  expect(values.message.灵力).toBe(5);
});

it('validates four-type direct scope declarations and load conditions', async()=>{
  const { atomicStateSchema } = await import('../src/domain/state/atomic-schema.js');
  const state={schema_version:1,scopes:{message:{灵力:{type:'number',initial:5,min:0,max:10},游戏状态:{type:'json',initial:{阶段:'日常'},description:'游戏进程',load:{mode:'always'}}}}};
  expect(atomicStateSchema.safeParse(state).success).toBe(true);
  expect(atomicStateSchema.safeParse({schema_version:1,scopes:{message:{'无效.名称':{type:'number',initial:1}}}}).success).toBe(false);
  expect(atomicStateSchema.safeParse({schema_version:1,scopes:{message:{灵力:{type:'integer',initial:1}}}}).success).toBe(false);
  expect(atomicStateSchema.safeParse({schema_version:1,scopes:{message:{灵力:{type:'number'}}}}).success).toBe(false);
  expect(atomicStateSchema.safeParse({schema_version:1,scopes:{message:{灵力:{type:'number',initial:1,load:{mode:'on_mention'}}}}}).success).toBe(false);
});
