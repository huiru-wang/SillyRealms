import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolvePresentation} from '../src/features/worlds/presentation.ts';
import {presentationPreview,retainPreview} from '../src/features/worlds/preview-cache.ts';

test('only an explicitly supplied public opening body is a missing-presentation fallback',()=>{
  assert.equal(resolvePresentation(undefined),null);
  assert.equal(resolvePresentation(null),null);
  assert.deepEqual(resolvePresentation(undefined,'Public opening'),{type:'markdown',text:'Public opening'});
  const component={type:'component',component:'InnIntroduction'};
  assert.strictEqual(resolvePresentation(component,'Public opening'),component);
  const markdown={type:'markdown',text:'Player introduction'};
  assert.strictEqual(resolvePresentation(markdown,'Model-only character content'),markdown);
  assert.equal(presentationPreview(markdown,'character:owner','Owner'),null);
  assert.equal(presentationPreview(undefined,'character:owner','Owner'),null);
});

test('world, opening and character presentations have independent instances even for one shared module',()=>{
  const component={type:'component',component:'SharedIntroduction'};
  const world=presentationPreview(component,'introduction','World');
  const opening=presentationPreview(component,'opening:first','First');
  const character=presentationPreview(component,'character:owner','Owner','dialog');
  let entries=[];
  for(const item of [world,opening,character])entries=retainPreview(entries,item);
  assert.deepEqual(entries.map(item=>item.id),['introduction','opening:first','character:owner']);
  assert.equal(character.surface,'dialog');
  assert.strictEqual(retainPreview(entries,null),entries);
  assert.strictEqual(retainPreview(entries,character),entries);
  assert.strictEqual(retainPreview(entries,world),entries);
});

test('closed character previews retain their FIFO position and share the ten-instance budget',()=>{
  const component={type:'component',component:'Role'};
  const first=presentationPreview(component,'character:one','One','dialog');
  let entries=retainPreview([],first);
  for(let i=0;i<9;i++)entries=retainPreview(entries,presentationPreview(component,'opening:'+i,'Opening '+i));
  const retained=entries;
  assert.strictEqual(retainPreview(entries,null),retained);
  assert.strictEqual(retainPreview(entries,first),retained);
  entries=retainPreview(entries,presentationPreview(component,'character:two','Two','dialog'));
  assert.equal(entries.length,10);
  assert.equal(entries.some(item=>item.id===first.id),false);
  assert.deepEqual(entries.slice(0,9),retained.slice(1));
  assert.equal(entries.at(-1).surface,'dialog');
});
