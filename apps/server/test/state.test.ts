import { describe, expect, it } from 'vitest';
import { initialState, applyOpening, decodeMessageState } from '../src/domain/state/state.js';
import { evaluateWhen, validateWhen } from '../src/domain/state/when.js';

const schema = { schema_version: 1, scopes: { message: { modules: { hero: { type: 'object', properties: { hp: { type: 'integer', initial: 10, min: 0, max: 20 }, items: { type: 'array', items: { type: 'string' }, initial: [] } } } } } } };
describe('state and when', () => {
  it('initializes and validates opening overrides', () => {
    const base = initialState(schema, 'message');
    expect(applyOpening(schema, base, { hero: { hp: 5 } })).toEqual({ hero: { hp: 5, items: [] } });
    expect(() => decodeMessageState('[{\"key\":\"hero\",\"value\":{}},{\"key\":\"hero\",\"value\":{}}]')).toThrow();
    expect(() => applyOpening(schema, base, { hero: { hp: -1 } })).toThrow();
    expect(() => applyOpening(schema, base, { hero: { missing: 1 } })).toThrow();
    const invalid={schema_version:1,scopes:{message:{modules:{hero:{type:'object',properties:{items:{type:'array',items:{type:'unsupported'},initial:[]}}}}}}};
    expect(()=>initialState(invalid,'message')).toThrow();
    const badEnum={schema_version:1,scopes:{message:{modules:{hero:{type:'object',properties:{status:{type:'enum',values:[],initial:null,nullable:true}}}}}}};
    expect(()=>initialState(badEnum,'message')).toThrow();
  });
  it('evaluates only read-only expressions with short-circuit and scope', () => {
    const state = { global: {}, session: {}, message: { hero: { hp: 5 } } };
    expect(evaluateWhen('getState("hero.hp", {scope:"message"}) < 10', state)).toBe(true);
    expect(evaluateWhen('(getState("missing") ?? 0) === 0', state)).toBe(true);
    expect(() => evaluateWhen('!getState(\"missing\")', state)).toThrow();
    expect(() => validateWhen('process.exit()')).toThrow();
    expect(() => validateWhen('getState("x"); process.exit()')).toThrow();
    expect(() => evaluateWhen('getState("__proto__.x") === 1', state)).toThrow();
  });
});
