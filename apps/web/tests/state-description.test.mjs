import {test} from 'node:test';
import assert from 'node:assert/strict';
import {describeWorldState, shouldEnterStateDetail, stateDescriptionLabel} from '../src/features/worlds/state-description.ts';

const schema = scopes => ({schema_version: 2, scopes});
const scalar = (key, type, initial) => ({type, initial, description: key + '的含义', rules: {[key]: '模型更新规则'}});

test('state descriptions omit empty scopes and keep same-named roots independent', () => {
  const groups = describeWorldState(schema({message: {clock: scalar('clock', 'string', '傍晚')}, session: {}, global: {clock: scalar('clock', 'number', 0)}}));
  assert.deepEqual(groups.map(group => group.scope), ['global', 'message']);
  assert.equal(groups[0].nodes[0].description, 'clock的含义');
  assert.equal(groups[0].nodes[0].container, false);
  assert.equal(Object.hasOwn(groups[0].nodes[0], 'initial'), false);
  assert.deepEqual(describeWorldState(undefined), []);
});

test('declared nested fields remain discoverable with a null initial value and missing intermediate rules', () => {
  const state = schema({message: {restaurant: {type: 'json', initial: null, description: '根简介', rules: {
    restaurant: '经营规则', 'restaurant.pantry.rice.quantity': '记录大米余量',
    'restaurant.pantry.rice.unit': '计量单位', 'restaurant.service': '营业阶段',
  }}}});
  const original = JSON.stringify(state);
  const [root] = describeWorldState(state)[0].nodes;
  const pantry = root.children[0], rice = pantry.children[0];
  assert.equal(root.description, '经营规则');
  assert.equal(pantry.container, true);
  assert.equal(pantry.description, '');
  assert.deepEqual(rice.children.map(node => [node.path, node.description]), [
    ['restaurant.pantry.rice.quantity', '记录大米余量'], ['restaurant.pantry.rice.unit', '计量单位'],
  ]);
  assert.equal(JSON.stringify(state), original);
});

test('empty and populated arrays expose the same single element template', () => {
  const rules = {stock: '库存', 'stock[]': '每项食材', 'stock[].name': '食材名称', 'stock[].quantity': '余量'};
  const describe = initial => describeWorldState(schema({message: {stock: {type: 'json', initial, description: '库存简介', rules}}}))[0].nodes[0];
  const empty = describe([]), populated = describe([{name: '米', quantity: 4}, {name: '菜', quantity: 0}]);
  assert.deepEqual(empty.children[0].children.map(node => node.path), populated.children[0].children.map(node => node.path));
  assert.equal(empty.children[0].type, 'unknown');
  assert.equal(populated.children[0].type, 'object');
  assert.deepEqual(populated.children[0].children.map(node => node.type), ['string', 'number']);
  assert.equal(populated.children.length, 1);
  assert.equal(stateDescriptionLabel(populated.children[0]), '每项');
  assert.deepEqual(populated.children[0].children.map(node => node.key), ['name', 'quantity']);
});

test('nested arrays retain separate template levels and primitive element descriptions', () => {
  const root = describeWorldState(schema({message: {grid: {type: 'json', initial: [], description: '棋盘', rules: {
    grid: '棋盘规则', 'grid[]': '行', 'grid[][]': '单元格含义',
  }}}}))[0].nodes[0];
  assert.equal(root.children[0].container, true);
  assert.equal(root.children[0].children[0].path, 'grid[][]');
  assert.equal(root.children[0].children[0].description, '单元格含义');
  assert.equal(root.children[0].children[0].container, false);
});

test('empty objects and scalar JSON roots retain an expandable rule fallback', () => {
  for (const initial of [{}, null, 0, false, '']) {
    const node = describeWorldState(schema({global: {data: {type: 'json', initial, description: '简介', rules: {data: '根规则'}}}}))[0].nodes[0];
    assert.equal(node.container, true);
    assert.equal(node.description, '根规则');
    assert.deepEqual(node.children, []);
  }
  const root = describeWorldState(schema({message: {data: {type: 'json', initial: {empty: {}}, description: '简介', rules: {data: '根规则', 'data.empty': '空容器说明'}}}}))[0].nodes[0];
  assert.equal(root.children[0].container, true);
});

test('schema validation precedes projection, including unsafe or unrelated rule paths', () => {
  for (const path of ['data.__proto__.x', 'other.child']) {
    assert.throws(() => describeWorldState(schema({message: {data: {type: 'json', initial: null, description: '简介', rules: {data: '根规则', [path]: '不合法'}}}})));
  }
});

test('mobile drill-in starts at the third container level and desktop stays expandable', () => {
  assert.deepEqual([0, 1, 2, 3].map(depth => shouldEnterStateDetail(true, depth)), [false, false, true, true]);
  assert.equal(shouldEnterStateDetail(false, 8), false);
});
test('JSON roots without rules keep their description and expose unannotated children', () => {
  const field = {type: 'json', initial: {gold: 1}, description: '背包'};
  const root = describeWorldState(schema({message: {bag: field}}))[0].nodes[0];
  assert.equal(root.description, '背包');
  assert.equal(root.children[0].description, '');
});

test('root types stay declared while nested badges reflect observed values, including null and mixed arrays', () => {
  const groups = describeWorldState(schema({session: {
    enabled: scalar('enabled', 'boolean', false),
    data: {type: 'json', initial: {flags: [false, true], items: [0, null, 1], value: null}, description: '字段'},
  }}));
  const [enabled, data] = groups[0].nodes;
  assert.equal(enabled.type, 'boolean');
  assert.equal(data.type, 'json');
  const [flags, items, value] = data.children;
  assert.equal(flags.type, 'array');
  assert.equal(flags.children[0].type, 'boolean');
  assert.equal(items.children[0].type, 'mixed');
  assert.equal(value.type, 'null');
});
