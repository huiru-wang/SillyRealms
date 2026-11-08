import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {openingStateRows} from '../src/features/worlds/opening-state';
import {applyOpening, initialState} from '../../server/src/domain/state/state';

const card = JSON.parse(readFileSync(new URL('../../server/test/fixtures/worldstory-card.json', import.meta.url), 'utf8')).data;
test('opening preview matches server for imported fixture and whole JSON replacement', () => {
  const state = structuredClone(card.state);
  state.scopes.message['进度'].initial = {阶段: '准备', 保留: true};
  const override = card.openings[0].initial_state;
  const actual = Object.fromEntries(openingStateRows(state, override).map(row => [row.name, row.value]));
  assert.deepEqual(actual, applyOpening(state, initialState(state, 'message'), override));
  assert.deepEqual(actual['进度'], {阶段: '初遇'});
});
test('defaults, absent message scope, and malformed values', () => {
  assert.deepEqual(openingStateRows({schema_version: 1, scopes: {global: {}}}, undefined), []);
  const state = {schema_version: 1, scopes: {message: {flag: {type: 'boolean', initial: false}}}};
  assert.deepEqual(openingStateRows(state, undefined), [{name: 'flag', value: false, overridden: false}]);
  assert.throws(() => openingStateRows(state, {missing: 1}));
  assert.throws(() => openingStateRows(state, {flag: 'true'}));
  assert.throws(() => openingStateRows({schema_version: 1, scopes: {message: {flag: {type: 'boolean'}}}}, {}));
});
