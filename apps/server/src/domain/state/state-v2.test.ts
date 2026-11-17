import { describe, expect, it } from 'vitest';
import {
  STATE_MAX_BYTES, StateValidationError, isSafeStateKey, validateStateDefinition,
  validateStateJson, validateStateSchema, validateStateValue,
  type Json, type StateDefinition, type StateSchema, type StateScope,
} from '@sillyrealms/sdk/state-validation';
import { atomicStateSchema } from './atomic-schema.js';
import { applyAtomicUpdates, initialAtomicState, updateAtomicState, validateAtomicSnapshot } from './atomic-state.js';
import { applyOpening, decodeMessageState, initialState, validateSnapshot } from './state.js';
import { applyRuntimeStateUpdate } from './runtime-update.js';

const json = (initial: Json, rules: Record<string, string> = {}): StateDefinition => ({
  type:'json', initial, description:'  模块说明\n原文  ', rules:{root:'  根规则\n保持原文  ', ...rules},
});
const schema = (definition: StateDefinition, scope: StateScope = 'message'): StateSchema => ({
  schema_version:2, scopes:{[scope]:{root:definition}},
});
function failure(run: () => unknown): StateValidationError {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(StateValidationError);
    return error as StateValidationError;
  }
  throw new Error('Expected state validation to fail');
}

describe('state v2 definitions and rule paths', () => {
  it('requires v2, strict fields, descriptions, explicit initial values, and root rules', () => {
    const definition = json({});
    expect(atomicStateSchema.safeParse(schema(definition)).success).toBe(true);
    for (const value of [
      {...schema(definition),schema_version:1},
      {...schema(definition),unexpected:true},
      {schema_version:2,scopes:{unknown:{root:definition}}},
      schema({...definition,unexpected:true} as StateDefinition),
      schema({...definition,description:' \n '}),
      schema({...definition,rules:{}}),
      schema({...definition,rules:{root:' \n '}}),
      {schema_version:2,scopes:{message:{root:{type:'json',description:'x',rules:{root:'x'}}}}},
    ]) expect(atomicStateSchema.safeParse(value).success).toBe(false);
    expect(failure(() => validateStateSchema(null)).code).toBe('INVALID_STATE');
    expect(failure(() => initialState({schema_version:1,scopes:{}}, 'message')).code).toBe('INVALID_STATE');
  });

  it('preserves description and rule text, order, and future field declarations', () => {
    const definition = json({}, {'root.optional':'future','root.optional.child':'future child'});
    const parsed = atomicStateSchema.parse(schema(definition));
    expect(parsed.scopes.message!.root).toEqual(definition);
    expect(Object.keys(parsed.scopes.message!.root!.rules)).toEqual(['root','root.optional','root.optional.child']);
    expect(initialState(undefined,'message')).toEqual({});
  });

  it.each(['other','root[0]','root.[].x','root..x','root.','root[]tail','root.a[b]','root.__proto__','root.constructor','root.a]'])(
    'rejects the full invalid rule path %s', (path) => {
      const error = failure(() => validateStateDefinition('root', json({}, {[path]:'rule'}), 'session'));
      expect(error.details).toMatchObject({code:'INVALID_STATE_RULE_PATH',scope:'session',rulePath:path});
    },
  );

  it('allows Chinese and the existing legal characters without imposing extra key restrictions', () => {
    const root = '天气<早间>\n{{user}}';
    expect(isSafeStateKey(root)).toBe(true);
    expect(() => validateStateDefinition(root,{type:'string',initial:'晴',description:'天气',rules:{[root]:'记录天气'}})).not.toThrow();
    for (const key of ['', 'a.b', 'a[b]', '__proto__', 'constructor', 'prototype']) expect(isSafeStateKey(key)).toBe(false);
  });

  it('requires empty-array element rules and recursively covers nested arrays', () => {
    expect(failure(() => validateStateDefinition('root',json([]))).rulePath).toBe('root[]');
    expect(() => validateStateDefinition('root',json([],{'root[]':'item'}))).not.toThrow();
    expect(failure(() => validateStateDefinition('root',json([[]],{'root[]':'row'}))).rulePath).toBe('root[][]');
    expect(() => validateStateDefinition('root',json([[{n:1}]],{
      'root[]':'row','root[][]':'cell','root[][].n':'value',
    }))).not.toThrow();
  });

  it('requires object containers and the union of actual array fields', () => {
    expect(failure(() => validateStateDefinition('root',json({nested:{n:1}},{'root.nested.n':'n'}))).rulePath).toBe('root.nested');
    const definition = json([{left:1},{right:2}],{'root[]':'item','root[].left':'left'});
    expect(failure(() => validateStateDefinition('root',definition)).rulePath).toBe('root[].right');
    definition.rules['root[].right'] = 'right';
    expect(() => validateStateDefinition('root',definition)).not.toThrow();
  });

  it('keeps scope and missing/invalid rule paths in Zod custom diagnostics', () => {
    const missing = atomicStateSchema.safeParse(schema(json({child:1}), 'global'));
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.issues[0]).toMatchObject({
      path:['scopes','global','root','rules','root.child'],
      params:{stateDiagnostic:{code:'STATE_RULE_MISSING',scope:'global',path:'root.child',rulePath:'root.child'}},
    });
    const invalid = atomicStateSchema.safeParse(schema(json({}, {'other.child':'wrong root'}), 'session'));
    if (!invalid.success) expect(invalid.error.issues[0]).toMatchObject({
      path:['scopes','session','root','rules','other.child'],
      params:{stateDiagnostic:{code:'INVALID_STATE_RULE_PATH',scope:'session',rulePath:'other.child'}},
    });
    else throw new Error('Expected invalid rule path');
  });

  it('rejects forbidden raw rule keys before a record parser can discard them', () => {
    const raw = JSON.parse('{"schema_version":2,"scopes":{"message":{"root":{"type":"json","initial":{},"description":"root","rules":{"root":"rule","__proto__":"invalid"}}}}}');
    const parsed = atomicStateSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]).toMatchObject({
      params:{stateDiagnostic:{code:'INVALID_STATE_RULE_PATH',scope:'message',rulePath:'__proto__'}},
    });
  });

  it('retains current load and when validation', () => {
    const definition = json({});
    definition.load = {mode:'on_mention',keywords:['  小饭馆  '],when:"getState('score') > 0"};
    const parsed = atomicStateSchema.parse(schema(definition));
    expect(parsed.scopes.message!.root!.load!.keywords).toEqual(['小饭馆']);
    expect(atomicStateSchema.safeParse(schema({...definition,load:{mode:'on_mention',keywords:[]}})).success).toBe(false);
    expect(atomicStateSchema.safeParse(schema({...definition,load:{when:'process.exit()'}})).success).toBe(false);
  });
});

describe('complete root value safety and limits', () => {
  it.each([null,true,7,'value',{},[]] satisfies Json[])('accepts JSON root value %j', (value) => {
    expect(() => validateStateDefinition('root',json(value,{'root[]':'array item'}))).not.toThrow();
  });

  it('checks finite numbers, root ranges, dangerous keys, and JSON data', () => {
    const count: StateDefinition = {type:'number',initial:0,min:0,max:0,description:'count',rules:{root:'count'}};
    expect(() => validateStateDefinition('root',count)).not.toThrow();
    expect(failure(() => validateStateValue(count,1,'root','session')).details).toMatchObject({code:'STATE_OUT_OF_RANGE',scope:'session',path:'root'});
    expect(failure(() => validateStateDefinition('root',{...count,min:2,max:1})).code).toBe('INVALID_STATE_RANGE');
    expect(failure(() => validateStateDefinition('root',{...count,type:'json'})).code).toBe('INVALID_STATE_RANGE');
    for (const value of [NaN,Infinity,undefined,new Date(),{bad:undefined},JSON.parse('{"__proto__":1}'),{'x[y]':1}])
      expect(() => validateStateJson(value)).toThrow(StateValidationError);
  });

  it('counts root depth from zero and checks the complete resulting value', () => {
    let value: Json = 0;
    for (let index=0;index<32;index++) value={x:value};
    expect(() => validateStateJson(value)).not.toThrow();
    expect(failure(() => validateStateJson({x:value})).code).toBe('STATE_VALUE_TOO_DEEP');
  });

  it('enforces UTF-8 size for individual roots and the whole state definition', () => {
    const text: StateDefinition = {type:'string',initial:'',description:'text',rules:{root:'text'}};
    expect(() => validateStateValue(text,'x'.repeat(STATE_MAX_BYTES-2),'root')).not.toThrow();
    expect(failure(() => validateStateValue(text,'x'.repeat(STATE_MAX_BYTES-1),'root')).code).toBe('STATE_VALUE_TOO_LARGE');
    const large = json({}, {root:'x'.repeat(600000)});
    expect(failure(() => validateStateSchema({schema_version:2,scopes:{global:{root:large},message:{root:large}}})).code).toBe('STATE_VALUE_TOO_LARGE');
  });

  it('does not invent nested required/type/enum constraints from rule text', () => {
    const definition=json({day:1},{'root.day':'positive integer; preserve the field'});
    expect(() => validateStateValue(definition,{},'root')).not.toThrow();
    expect(() => validateStateValue(definition,{day:'unknown'},'root')).not.toThrow();
    expect(() => validateStateValue(definition,null,'root')).not.toThrow();
  });
});

describe('state v2 initialization, snapshots, and atomic writes', () => {
  const definition=json({day:1,period:'morning'},{'root.day':'day','root.period':'period','root.optional':'optional','root.optional.child':'child'});

  it('replaces entire opening roots and validates without mutating initial values', () => {
    const state=schema(definition);
    const initial=initialState(state,'message');
    expect(applyOpening(state,initial,{root:{day:2}})).toEqual({root:{day:2}});
    expect(initial).toEqual({root:{day:1,period:'morning'}});
    expect(failure(() => applyOpening(state,initial,{root:{day:2,unknown:true}})).details).toMatchObject({code:'STATE_RULE_MISSING',scope:'message',rulePath:'root.unknown'});
    expect(failure(() => applyOpening(state,initial,{other:1})).code).toBe('STATE_NOT_FOUND');
    expect(failure(() => applyOpening(state,initial,{'root.day':2})).code).toBe('INVALID_STATE_KEY');
  });

  it('validates the exact complete root set in every scope and keeps structured errors', () => {
    for (const scope of ['global','session','message'] as const) {
      const state=schema(definition,scope);
      expect(() => validateSnapshot(state,scope,initialState(state,scope))).not.toThrow();
      expect(failure(() => validateSnapshot(state,scope,{})).details).toMatchObject({code:'STATE_SCHEMA_MISMATCH',scope,path:'root'});
      expect(failure(() => validateSnapshot(state,scope,{root:{day:1},extra:1})).code).toBe('STATE_SCHEMA_MISMATCH');
      expect(failure(() => validateSnapshot(state,scope,{root:{unruled:1}})).details).toMatchObject({code:'STATE_RULE_MISSING',scope,rulePath:'root.unruled'});
    }
  });

  it('does not publish an invalid replacement or let it contaminate the next write', () => {
    const fields={root:definition};
    const values=initialAtomicState(fields);
    updateAtomicState(values,fields,'root.day',2);
    expect(failure(() => updateAtomicState(values,fields,'root',{day:3,unruled:true})).rulePath).toBe('root.unruled');
    expect(values.root).toEqual({day:2,period:'morning'});
    updateAtomicState(values,fields,'root.day',4);
    expect(values.root).toEqual({day:4,period:'morning'});
    expect(() => validateAtomicSnapshot(fields,values)).not.toThrow();
  });

  it('allows predeclared new fields only when their parent exists, and rejects array paths', () => {
    const fields={root:definition};
    const values=initialAtomicState(fields);
    expect(failure(() => updateAtomicState(values,fields,'root.optional.child',1)).code).toBe('INVALID_STATE_PATH');
    updateAtomicState(values,fields,'root.optional',{child:1});
    updateAtomicState(values,fields,'root.optional.child',2);
    for (const path of ['root.optional[]','root.optional[0]','root..day'])
      expect(failure(() => updateAtomicState(values,fields,path,0)).code).toBe('INVALID_STATE_PATH');
    const arrays={root:json([1],{'root[]':'element'})};
    expect(failure(() => updateAtomicState(initialAtomicState(arrays),arrays,'root.0',2)).code).toBe('INVALID_STATE_PATH');
  });

  it('checks model activation while allowing SDK/domain writes to any declared root', () => {
    const fields={root:definition};
    const values=initialAtomicState(fields,'global');
    expect(failure(() => applyRuntimeStateUpdate(values,fields,new Set(),'root.day',2)).code).toBe('STATE_ROOT_NOT_ACTIVE');
    expect(() => updateAtomicState(values,fields,'root.day',2,'global')).not.toThrow();
    expect(failure(() => updateAtomicState(values,fields,'root.unruled',2,'global')).details).toMatchObject({scope:'global',rulePath:'root.unruled'});
  });

  it('retains successful items in order, skips invalid items, and emits only net changes', () => {
    const fields={root:definition};
    const baseline={global:initialAtomicState(fields),session:{},message:{}};
    const result=applyAtomicUpdates(baseline,{global:fields,session:{},message:{}},[
      {scope:'global',path:'root.day',value:2},
      {scope:'global',path:'root',value:{unruled:3}},
      {scope:'global',path:'root.day',value:1},
    ]);
    expect(result.results.map(item=>item.success)).toEqual([true,false,true]);
    expect(result.results[1]).toMatchObject({errorCode:'STATE_RULE_MISSING',stateDiagnostic:{scope:'global',rulePath:'root.unruled'}});
    expect(result.values).toEqual(baseline);
    expect(result.changes).toEqual([]);
  });

  it('rejects unsafe/duplicate stored snapshot keys before inheritance can consume them', () => {
    expect(decodeMessageState('[{"key":"root","value":{"day":1}}]')).toEqual({root:{day:1}});
    for (const text of ['[{"key":"root[]","value":1}]','[{"key":"root","value":1},{"key":"root","value":2}]'])
      expect(() => decodeMessageState(text)).toThrow(StateValidationError);
  });
});
