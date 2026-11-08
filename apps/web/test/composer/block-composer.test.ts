import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEditor,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import {$createRoleplayBlockNode, $isRoleplayBlockNode, RoleplayBlockNode} from '../../src/features/sessions/composer/roleplay-nodes.ts';
import {$exitRoleplayBlock, $insertRoleplayBlock, normalizeRoleplayBlockPaste} from '../../src/features/sessions/composer/composer-operations.ts';

function editor() {
  return createEditor({namespace: 'block-composer-test', nodes: [RoleplayBlockNode]});
}
function childSummary(instance: ReturnType<typeof editor>) {
  const result: Array<{kind:string;text:string}> = [];
  instance.getEditorState().read(() => {
    for (const node of $getRoot().getChildren()) {
      result.push({kind:$isRoleplayBlockNode(node)?node.getKind():'action',text:node.getTextContent()});
    }
  });
  return result;
}

test('inserting into an empty first row replaces it without a leading or trailing row', () => {
  const instance=editor();
  instance.update(() => {
    const paragraph=$createParagraphNode();$getRoot().append(paragraph);paragraph.selectStart();
    $insertRoleplayBlock('thought');
  },{discrete:true});
  assert.deepEqual(childSummary(instance),[{kind:'thought',text:''}]);
  instance.getEditorState().read(()=>{
    const selection=$getSelection();assert.ok($isRangeSelection(selection));
    assert.ok($isRoleplayBlockNode(selection.anchor.getNode().getTopLevelElementOrThrow()));
  });
});

test('inserting in the middle splits action text around a block and keeps both sides', () => {
  const instance=editor();
  instance.update(() => {
    const paragraph=$createParagraphNode(),text=$createTextNode('走进房间');paragraph.append(text);$getRoot().append(paragraph);
    text.select(2,2);$insertRoleplayBlock('speech');
  },{discrete:true});
  assert.deepEqual(childSummary(instance),[
    {kind:'action',text:'走进'},
    {kind:'speech',text:''},
    {kind:'action',text:'房间'},
  ]);
});

test('inserting at the start or end does not leave an accidental empty action row', () => {
  for (const offset of [0,4]) {
    const instance=editor();
    instance.update(() => {
      const paragraph=$createParagraphNode(),text=$createTextNode('房间里');paragraph.append(text);$getRoot().append(paragraph);
      text.select(offset,offset);$insertRoleplayBlock('thought');
    },{discrete:true});
    const summary=childSummary(instance);
    assert.equal(summary.length,2,JSON.stringify(summary));
    assert.equal(summary.filter(item=>item.kind==='thought').length,1);
    assert.equal(summary.filter(item=>item.text==='').length,1,'only the new typed block should be empty');
  }
});

test('inserting another type after a typed block replaces its existing empty next row', () => {
  const instance=editor();
  instance.update(() => {
    const thought=$createRoleplayBlockNode('thought');thought.append($createTextNode('想法'));
    const empty=$createParagraphNode();$getRoot().append(thought,empty);empty.selectStart();
    $insertRoleplayBlock('speech');
  },{discrete:true});
  assert.deepEqual(childSummary(instance),[
    {kind:'thought',text:'想法'},
    {kind:'speech',text:''},
  ]);
});

test('Enter exit creates or reuses the next ordinary paragraph', () => {
  const instance=editor();
  instance.update(() => {
    const typed=$createRoleplayBlockNode('thought');typed.append($createTextNode('我在想'));$getRoot().append(typed);
    $exitRoleplayBlock(typed);
  },{discrete:true});
  assert.deepEqual(childSummary(instance),[{kind:'thought',text:'我在想'},{kind:'action',text:''}]);
  instance.getEditorState().read(()=>{
    const selection=$getSelection();assert.ok($isRangeSelection(selection));
    assert.equal(selection.anchor.getNode().getTopLevelElementOrThrow().getTextContent(),'');
  });
});

test('Enter exit inserts an action row before an existing following block', () => {
  const instance=editor();
  instance.update(() => {
    const typed=$createRoleplayBlockNode('speech');typed.append($createTextNode('你好'));
    const next=$createParagraphNode();next.append($createTextNode('后续旁白'));
    $getRoot().append(typed,next);$exitRoleplayBlock(typed);
  },{discrete:true});
  assert.deepEqual(childSummary(instance),[
    {kind:'speech',text:'你好'},
    {kind:'action',text:''},
    {kind:'action',text:'后续旁白'},
  ]);
});

test('instruction insertion is unique, tail-positioned, and replaces a trailing empty row', () => {
  const instance=editor();
  instance.update(() => {
    const action=$createParagraphNode();action.append($createTextNode('旁白'));
    const instruction=$createRoleplayBlockNode('instruction');instruction.append($createTextNode('保持克制'));
    const empty=$createParagraphNode();$getRoot().append(action,instruction,empty);
    $insertRoleplayBlock('instruction');
  },{discrete:true});
  assert.deepEqual(childSummary(instance),[
    {kind:'action',text:'旁白'},
    {kind:'instruction',text:'保持克制'},
  ]);
});

test('pasted newlines are flattened inside a single-line type block', () => {
  assert.equal(normalizeRoleplayBlockPaste('第一行\r\n第二行\n第三行'),'第一行 第二行 第三行');
});
