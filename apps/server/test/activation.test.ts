import { describe, expect, it } from 'vitest';
import { evaluateLoad } from '../src/agent/context/activation.js';
import { setState, stateToolInstructions } from '../src/agent/tools/state-tool.js';
import type { AtomicStateDefinition } from '../src/domain/state/atomic-state.js';

describe('content activation and direct state tool', () => {
  it('combines keyword, exclusions and when', () => {
    const state={global:{},session:{},message:{hero:{hp:5}}};
    expect(evaluateLoad({mode:'on_mention',keywords:['hero'],when:'getState("hero.hp") < 10'},['hero arrives'],state).active).toBe(true);
    expect(evaluateLoad({mode:'on_mention',keywords:['hero'],exclude_keywords:['gone']},['hero gone'],state).reason).toBe('excluded');
    expect(evaluateLoad({mode:'always',when:'false'},[],state).reason).toBe('when_false');
    expect(evaluateLoad({mode:'never'},[],state).reason).toBe('never');
  });
  it('validates active state fields and JSON paths before changing the workspace',()=>{
    const fields:Record<string,AtomicStateDefinition>={hp:{type:'number',initial:5,min:0,max:10},people:{type:'json',initial:{}}};
    const state={hp:5,people:{}};
    expect(()=>setState(state,fields,new Set(['hp']),'hp',100)).toThrow();
    expect(state.hp).toBe(5);
    setState(state,fields,new Set(['hp']),'hp',7);
    expect(state.hp).toBe(7);
    expect(()=>setState(state,fields,new Set(),'hp',2)).toThrow();
    setState(state,fields,new Set(['people']),['people','Alice'],{hp:50});
    setState(state,fields,new Set(['people']),'people.Alice.hp',70);
    expect(state.people).toEqual({Alice:{hp:70}});
    expect(()=>setState(state,fields,new Set(['people']),'people.__proto__',{})).toThrow();
  });
  it('describes only active fields and number limits',()=>{
    const fields={hp:{type:'number',initial:5,min:0,max:10,description:'{{user}} HP'},hidden:{type:'string',initial:'secret'}};
    const text=stateToolInstructions(fields,new Set(['hp']),s=>s.replace('{{user}}','玩家'));
    expect(text).toContain('"path":["hp"]');expect(text).toContain('"min":0');expect(text).toContain('"max":10');expect(text).toContain('玩家 HP');expect(text).not.toContain('secret');
  });
});

it('state review accepts no-change and atomically rejects invalid batches',async()=>{
  const {ToolExecutor}=await import('../src/agent/tools/tool-executor.js');
  const executor=new ToolExecutor();
  const workspace={hp:1,money:5};
  const modules={hp:{type:'number' as const,initial:1,min:0,max:10},money:{type:'number' as const,initial:5}};
  const active=new Set(['hp','money']);
  const makeCall=(updates:Array<{path:string;value:string|number}>)=>({type:'toolCall' as const,id:'r',name:'review_state',arguments:{updates}});
  expect(executor.executeReview(makeCall([]),workspace,modules,active).isError).toBe(false);
  expect(workspace).toEqual({hp:1,money:5});
  const failed=executor.executeReview(makeCall([{path:'hp',value:7},{path:'money',value:'invalid'}]),workspace,modules,active);
  expect(failed.isError).toBe(true);
  expect(workspace).toEqual({hp:1,money:5});
  expect(executor.executeReview(makeCall([{path:'hp',value:7}]),workspace,modules,active).isError).toBe(false);
  expect(workspace.hp).toBe(7);
});
