import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openingStateRows} from '../src/features/worlds/opening-state.ts';
import {INITIAL_ARRAY_PAGE_SIZE, initialTextPreview, initialValueChildren, initialValueSize, initialValueText} from '../src/features/worlds/initial-state-values.ts';

const node = value => ({key: 'restaurant', path: 'restaurant', value});
const definition = (initial, rules) => ({type: 'json', initial, description: '经营状态', rules});

test('opening overrides replace whole roots and never synthesize rule-only fields', () => {
  const state = {schema_version: 2, scopes: {
    global: {global: definition(9, {global: '全局'})},
    session: {session: definition('hidden', {session: '会话'})},
    message: {restaurant: definition({service: '营业中', tables: 3}, {
      restaurant: '经营', 'restaurant.service': '阶段', 'restaurant.tables': '桌数', 'restaurant.future': '未来字段',
    }), coins: {type: 'number', initial: 0, description: '余额', rules: {coins: '记录余额'}}},
  }};
  const before = JSON.stringify(state), override = {restaurant: {service: '准备开门'}};
  const rows = openingStateRows(state, override);
  assert.deepEqual(rows, [{name: 'restaurant', value: {service: '准备开门'}, overridden: true}, {name: 'coins', value: 0, overridden: false}]);
  assert.deepEqual(initialValueChildren(node(rows[0].value)), [{key: 'service', path: 'restaurant.service', value: '准备开门'}]);
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(override, {restaurant: {service: '准备开门'}});
});

test('explicit null, false, zero and empty overrides remain distinct from missing overrides', () => {
  const state = {schema_version: 2, scopes: {message: {restaurant: definition('世界默认', {restaurant: '规则', 'restaurant[]': '条目'})}}};
  for (const value of [null, false, 0, '', [], {}]) {
    const [row] = openingStateRows(state, {restaurant: value});
    assert.equal(row.overridden, true);
    assert.deepEqual(row.value, value);
    assert.equal(initialValueSize(row.value), 0);
  }
  assert.deepEqual(openingStateRows(state, undefined), [{name: 'restaurant', value: '世界默认', overridden: false}]);
});

test('value labels distinguish null, empty collections, false and zero without translating author text', () => {
  assert.deepEqual([null, '', [], {}, true, false, 0, -12.5, '暂无字段', '  原文\n保留  '].map(initialValueText),
    ['尚未确定', '空文本', '暂无条目', '暂无字段', '是', '否', '0', '-12.5', '暂无字段', '  原文\n保留  ']);
  assert.equal(initialValueSize({quantity: 0}), 1);
  assert.equal(initialValueSize([null]), 1);
  assert.deepEqual(initialValueChildren(node(null)), []);
});

test('arrays paginate actual entries with stable indexes instead of a shared element template', () => {
  const values = Array.from({length: 45}, (_, index) => ({name: `食材${index}`, quantity: index}));
  const first = initialValueChildren(node(values));
  const second = initialValueChildren(node(values), INITIAL_ARRAY_PAGE_SIZE * 2);
  const all = initialValueChildren(node(values), INITIAL_ARRAY_PAGE_SIZE * 3);
  assert.equal(first.length, 20); assert.equal(second.length, 40); assert.equal(all.length, 45);
  assert.deepEqual(second.slice(0, first.length), first);
  assert.equal(first[0].key, '第 1 项'); assert.equal(all[44].path, 'restaurant[44]');
  assert.deepEqual(initialValueChildren(all[44]), [
    {key: 'name', path: 'restaurant[44].name', value: '食材44'},
    {key: 'quantity', path: 'restaurant[44].quantity', value: 44},
  ]);
  assert.equal(values.length, 45);
});

test('nested arrays and scalar array elements preserve their actual values and paths', () => {
  const items = initialValueChildren(node([[0, false], [], '米', null]));
  assert.deepEqual(initialValueChildren(items[0]), [
    {key: '第 1 项', path: 'restaurant[0][0]', value: 0},
    {key: '第 2 项', path: 'restaurant[0][1]', value: false},
  ]);
  assert.equal(initialValueSize(items[1].value), 0);
  assert.equal(initialValueText(items[2].value), '米');
  assert.equal(initialValueText(items[3].value), '尚未确定');
});

test('long text previews preserve short text, line breaks and complete Unicode characters', () => {
  const text = '第一行\n第二行';
  assert.deepEqual(initialTextPreview(text), {text, shortened: false});
  assert.deepEqual(initialTextPreview('一\n二\n三\n四\n五'), {text: '一\n二\n三\n四…', shortened: true});
  assert.deepEqual(initialTextPreview('🍚'.repeat(241)), {text: '🍚'.repeat(240) + '…', shortened: true});
});

test('invalid initial overrides still fail schema validation before entering the value browser', () => {
  const state = {schema_version: 2, scopes: {message: {coins: {type: 'number', initial: 1, description: '余额', min: 0, rules: {coins: '交易'}}}}};
  assert.throws(() => openingStateRows(state, {coins: -1}), /STATE_OUT_OF_RANGE/);
  assert.throws(() => openingStateRows(state, {coins: null}), /INVALID_STATE_VALUE/);
  assert.throws(() => openingStateRows(state, {unknown: 1}), /STATE_NOT_FOUND/);
});
