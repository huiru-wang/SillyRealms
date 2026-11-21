import assert from 'node:assert/strict';
import test from 'node:test';
import {presetMenuPlacement} from '../src/features/presets/menu-placement.ts';

test('a compact menu stays below when its measured height fits, despite the old 280px estimate', () => {
  assert.deepEqual(presetMenuPlacement({top:120,bottom:152}, {top:0,bottom:394}, {top:0,bottom:600}, 192),
    {above:false,maxHeight:230});
});

test('a menu near the bottom opens upwards using the space actually available', () => {
  assert.deepEqual(presetMenuPlacement({top:500,bottom:532}, {top:0,bottom:560}, {top:0,bottom:800}, 224),
    {above:true,maxHeight:488});
});

test('when neither side fits, the larger side provides a bounded scrollable menu', () => {
  assert.deepEqual(presetMenuPlacement({top:170,bottom:202}, {top:100,bottom:320}, {top:0,bottom:800}, 280),
    {above:false,maxHeight:106});
});

test('the visible viewport constrains a menu while the mobile keyboard is open', () => {
  assert.deepEqual(presetMenuPlacement({top:260,bottom:304}, {top:0,bottom:700}, {top:100,bottom:360}, 224),
    {above:true,maxHeight:148});
});

test('an anchor scrolled out of view or without menu space closes its menu', () => {
  assert.equal(presetMenuPlacement({top:40,bottom:72}, {top:100,bottom:500}, {top:0,bottom:800}, 192), null);
  assert.equal(presetMenuPlacement({top:122,bottom:168}, {top:110,bottom:180}, {top:0,bottom:800}, 192), null);
});
