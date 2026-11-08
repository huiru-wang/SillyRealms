import { describe, expect, it } from 'vitest';
import { initialState, applyOpening, decodeMessageState } from '../src/domain/state/state.js';
import { evaluateWhen, validateWhen } from '../src/domain/state/when.js';

const schema={schema_version:1,scopes:{message:{hero:{type:'json',initial:{hp:10,items:[]}},hp:{type:'number',initial:10,min:0,max:20}}}};
describe('state and when',()=>{
  it('initializes directly declared fields and replaces JSON opening overrides',()=>{
    const base=initialState(schema,'message');
    expect(applyOpening(schema,base,{hero:{hp:5}})).toEqual({hero:{hp:5},hp:10});
    expect(()=>decodeMessageState('[{"key":"hero","value":{}},{"key":"hero","value":{}}]')).toThrow();
    expect(()=>applyOpening(schema,base,{hp:-1})).toThrow();
    expect(()=>applyOpening(schema,base,{missing:1})).toThrow();
    expect(()=>initialState({schema_version:1,scopes:{message:{bad:{type:'integer',initial:1}}}},'message')).toThrow();
  });
  it('evaluates only read-only expressions with short-circuit and scope',()=>{
    const state={global:{},session:{},message:{hero:{hp:5}}};
    expect(evaluateWhen('getState("hero.hp", {scope:"message"}) < 10',state)).toBe(true);
    expect(evaluateWhen('(getState("missing") ?? 0) === 0',state)).toBe(true);
    expect(()=>evaluateWhen('!getState("missing")',state)).toThrow();
    expect(()=>validateWhen('process.exit()')).toThrow();
    expect(()=>validateWhen('getState("x"); process.exit()')).toThrow();
    expect(()=>evaluateWhen('getState("__proto__.x") === 1',state)).toThrow();
  });
});
