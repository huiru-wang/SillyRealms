import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loreStateReferences,stateReferencePath} from '../src/features/worlds/lore-condition.ts';

test('lists all branches in source order, merging equivalent paths only within the same scope',()=>{
 const expression=`getState('人物.声望', {scope:'session'}) > 3
   ? getState(["人物","声望"], {scope:'session'}) === getState('人物.声望', {scope:'global'})
   : !getState('人物.声望') || getState('物品[0].名称', {scope:'message'}) === '钥匙'`;
 assert.deepEqual(loreStateReferences(expression),[
  {path:['人物','声望'],scope:'session'}, {path:['人物','声望'],scope:'global'},
  {path:['人物','声望'],scope:null}, {path:['物品','0','名称'],scope:'message'},
 ]);
 assert.equal(stateReferencePath(['人物','声望']),'人物.声望');
 assert.equal(stateReferencePath(['物品','特殊.名称']),'物品["特殊.名称"]');
});

test('ignores apparent calls in comments and literals and does not report partial invalid expressions',()=>{
 assert.deepEqual(loreStateReferences('true /* getState("隐藏") */ && false'),[]);
 assert.deepEqual(loreStateReferences('"getState(123)" === "test"'),[]);
 assert.equal(loreStateReferences('getState("金币") && unsupported()'),null);
});
