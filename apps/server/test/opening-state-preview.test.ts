import {expect, it} from 'vitest';
import {initialState, applyOpening} from '../src/domain/state/state.js';
import {openingStateRows} from '../../web/src/features/worlds/opening-state.js';

const state = {schema_version:1, scopes:{global:{shared:{type:'string', initial:'global'}}, session:{session:{type:'boolean', initial:true}}, message:{
  name:{type:'string', initial:'旅人'}, health:{type:'number', initial:8, min:0, max:10}, ready:{type:'boolean', initial:false}, inventory:{type:'json', initial:{coins:3, items:['key']}}
}}};
const snapshot = (override: unknown) => Object.fromEntries(openingStateRows(state, override).map(row => [row.name, row.value]));
it('matches the server message initial state for defaults and whole-item opening overrides', () => {
  for (const override of [undefined, {name:'访客', health:0, ready:true, inventory:{items:['map']}}]) {
    expect(snapshot(override)).toEqual(applyOpening(state, initialState(state, 'message'), override));
  }
  expect(snapshot({inventory:{items:['map']}}).inventory).toEqual({items:['map']});
  expect(openingStateRows(state, {ready:true}).find(row => row.name === 'ready')?.overridden).toBe(true);
});
it('rejects unknown and invalid overrides instead of inventing a preview', () => {
  for (const override of [{unknown:1}, {health:11}, {ready:'yes'}]) {
    expect(() => applyOpening(state, initialState(state, 'message'), override)).toThrow();
    expect(() => openingStateRows(state, override)).toThrow();
  }
  expect(openingStateRows({schema_version:1, scopes:{global:state.scopes.global}}, undefined)).toEqual([]);
});
