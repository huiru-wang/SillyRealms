import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StageComposerButtons} from '../../../packages/sr-sdk/src/stage/composer-buttons.ts';
import {bindComposerButtons} from '../src/stage-host/composer-buttons.ts';

test('a queued click only invokes the declaration that the player saw', async () => {
  const lists = [], clicks = [], calls = [];
  const stage = new StageComposerButtons(list => lists.push(list));
  let shown;
  const host = bindComposerButtons({postMessage: click => clicks.push(click)}, buttons => { shown = buttons; });
  const owner = Symbol();
  const bag = {id: 'bag', label: '背包', onClick: () => calls.push('bag')};
  stage.update(owner, [bag]);
  host.receive(lists[0]);
  const old = shown[0];
  old.click();
  const defend = {...bag, onClick: () => calls.push('new bag')};
  stage.update(owner, [defend]);
  await stage.click(clicks[0].revision, clicks[0].id);
  assert.deepEqual(calls, []);
  host.receive(lists[1]);
  host.receive(lists[0]);
  old.click();
  assert.equal(clicks.length, 1);
  shown[0].click();
  await stage.click(clicks[1].revision, clicks[1].id);
  assert.deepEqual(calls, ['new bag']);
  stage.update(owner, [{...defend}]);
  assert.equal(lists.length, 2);
  const retained = shown[0];
  host.close();
  retained.click();
  host.receive(lists[1]);
  assert.deepEqual(shown, []);
  assert.equal(clicks.length, 2);
});

test('the stage caps declarations, keeps author order and drops disabled or unmounted clicks', async () => {
  let list;
  const stage = new StageComposerButtons(value => { list = value; });
  const owner = Symbol(), calls = [];
  const buttons = Array.from({length: 6}, (_, i) => ({
    id: String(i), label: '操作' + i, disabled: i === 2, style: {width: '100%'},
    onClick: () => calls.push(i),
  }));
  stage.update(owner, buttons);
  assert.deepEqual(list.buttons, buttons.slice(0, 5).map(({id,label,disabled}) => ({id,label,disabled})));
  await stage.click(list.revision, '2');
  await stage.click(list.revision, '5');
  await stage.click(list.revision, '0');
  const rev = list.revision;
  stage.release(owner);
  assert.deepEqual(list.buttons, []);
  const nextOwner = Symbol();
  stage.update(nextOwner, buttons);
  stage.release(owner);
  await stage.click(rev, '0');
  await stage.click(list.revision, '1');
  assert.deepEqual(calls, [0, 1]);
});

test('the Host accepts bounded plain text, ignores invalid revisions and never adopts author styles', () => {
  const lists = [], clicks = [];
  const host = bindComposerButtons({postMessage: value => clicks.push(value)}, buttons => lists.push(buttons));
  const row = {id: 'ok', label: '<b>标签</b>', disabled: true, style: {position:'fixed'}};
  for (const buttons of [[row, row], Array(6).fill(row), [{...row, label: ' '}], [{...row, label: 'x'.repeat(257)}],
    [{...row, disabled:'yes'}], [null]]) host.receive({revision: 1, buttons});
  host.receive({revision: -1, buttons: []});
  assert.deepEqual(lists, []);
  host.receive({revision: 1, buttons: [row]});
  const [button] = lists[0];
  assert.equal(button.label, row.label);
  assert.equal(Object.hasOwn(button, 'style'), false);
  button.click();
  assert.deepEqual(clicks, []);
  host.receive({revision: 2, buttons: []});
  assert.deepEqual(lists[1], []);
});
