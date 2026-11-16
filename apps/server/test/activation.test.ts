import { describe, expect, it } from 'vitest';
import { evaluateLoad } from '../src/runtime/context/activation.js';
import {applyRuntimeStateUpdate as setState} from '../src/domain/state/runtime-update.js';
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
});
