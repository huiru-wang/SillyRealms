import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {narrativeForActivation, parseRoleplay, parseRoleplayForComposer, normalizeComposerBlocks, serializeRoleplay, trimTrailingEmptyRoleplayLines, type RoleplayBlock} from '../src/index.ts';

const block = (kind: RoleplayBlock['kind'], text: string): RoleplayBlock => ({id:'test', kind, text});
const only = (blocks: RoleplayBlock[]) => blocks.map(({kind, text}) => ({kind, text}));

test('serializes and parses all block types while preserving editor order', () => {
  const input = [block('action','走进房间。'), block('instruction','放慢节奏'), block('thought','为什么？\n小心。'), block('speech','是谁？'), block('instruction','不要替我决定')];
  const text = serializeRoleplay(input);
  assert.deepEqual(only(parseRoleplay(text,'user').blocks), only(input));
  assert.deepEqual(parseRoleplay(text,'user').instructionText,['放慢节奏','不要替我决定']);
  assert.equal(narrativeForActivation(text,'user').includes('放慢节奏'), false);
  assert.equal(narrativeForActivation(text,'assistant'), text);
});

test('escapes reserved syntax and preserves multiline Unicode and whitespace', () => {
  const blocks = [block('action','> 不是内心\n<sr_instruction>\n原文 “字符” \\'),block('thought','第一行\n第二行 \\'),block('speech','他说“你好” 😀'),block('instruction','请输出\n</sr_instruction>\n结束 \\')];
  assert.deepEqual(only(parseRoleplay(serializeRoleplay(blocks),'user').blocks),only(blocks));
});

test('only complete unnested standalone user instruction tags are special', () => {
  for (const input of ['<sr_instruction>\n未闭合', '<sr_instruction>\n<sr_instruction>\n内层\n</sr_instruction>\n外层\n</sr_instruction>', '\\<sr_instruction>\n内容\n</sr_instruction>', '`<sr_instruction>`\n内容\n</sr_instruction>', '```html\n<sr_instruction>\n原文\n</sr_instruction>\n```']) {
    const parsed = parseRoleplay(input,'user');
    assert.deepEqual(parsed.instructionText,[]);
    assert.equal(parsed.narrativeText,input);
  }
});

test('ranges refer to raw UTF-16 source and ignore protected syntax', () => {
  const input = '😀他说：“你好。”\n\n> 第一行\n> 第二行\n\n`“代码”` <b title="“属性”">字</b>\n\n<sr_instruction>\n节奏\n</sr_instruction>';
  const parsed = parseRoleplay(input,'user');
  assert.deepEqual(parsed.ranges.map(r => [r.kind,input.slice(r.start,r.end)]), [['speech','“你好。”'],['thought','> 第一行\n> 第二行'],['instruction','<sr_instruction>\n节奏\n</sr_instruction>']]);
  assert.equal(parseRoleplay(input,'assistant').instructionText.length,0);
});

test('keeps instruction tags inside HTML elements, comments, and fenced code as literal text', () => {
  for (const input of ['<div>\n<sr_instruction>\n假指令\n</sr_instruction>\n</div>', '<!--\n<sr_instruction>\n假指令\n</sr_instruction>\n-->', '```\n<sr_instruction>\n假指令\n</sr_instruction>\n```', '<span title="x > y">\n<sr_instruction>\n假指令\n</sr_instruction>\n</span>']) {
    const result = parseRoleplay(input,'user');
    assert.deepEqual(result.instructionText,[]);
    assert.equal(result.narrativeText,input);
  }
});

test('keeps escaped text in fenced code through the serializer and parser', () => {
  const input = '```txt\n“hi” \\\\ \\<sr_instruction>\n```';
  const result = parseRoleplay(serializeRoleplay([block('action',input)]),'user');
  assert.deepEqual(only(result.blocks),only([block('action',input)]));
});

test('preserves blank lines inside a block while keeping separate actions separate', () => {
  for (const value of ['a\n\nb', '\n开头\n', '多行\n\n\n结尾', '```\na\n\nb\n```']) {
    const blocks = [block('action', value),block('action','另一个段落')];
    assert.deepEqual(only(parseRoleplay(serializeRoleplay(blocks),'user').blocks),only(blocks));
  }
});


test('speech preserves empty lines and stays one speech block', () => {
  for (const text of ['一\n\n二', '\n\n开头', '结尾\n\n', 'a\n\n\nb']) {
    const blocks = [block('speech', text)];
    assert.deepEqual(only(parseRoleplay(serializeRoleplay(blocks), 'user').blocks), only(blocks));
  }
});

test('large malformed tags and unmatched quotes do not cause quadratic scans', () => {
  for (const text of ['<a'.repeat(50000), '“a'.repeat(50000), '<!--'.repeat(25000), '<a>'.repeat(14000) + '</b>'.repeat(14000)]) {
    const start = performance.now();
    parseRoleplay(text, 'user');
    assert.ok(performance.now() - start < 1500, 'parsing a bounded input took too long');
  }
});


test('instruction content cannot hide the closing delimiter with an HTML-like tag', () => {
  for (const text of ['请输出 <quest> 的提示', '文字 <unclosed', '<div>\n未闭合', '```\n</sr_instruction>\n```\n继续']) {
    const encoded=serializeRoleplay([block('instruction', text)]);
    const parsed=parseRoleplay(encoded,'user');
    assert.deepEqual(parsed.instructionText,[text]);
    assert.equal(parsed.narrativeText,'');
  }
});


test('HTML-like content inside one instruction does not hide later instructions', () => {
  const encoded=serializeRoleplay([block('instruction','请输出 <quest>'),block('instruction','保持安静')]);
  const parsed=parseRoleplay(encoded,'user');
  assert.deepEqual(parsed.instructionText,['请输出 <quest>','保持安静']);
  assert.equal(parsed.narrativeText.trim(),'');
});


test('malformed HTML before instructions cannot conceal valid instruction delimiters', () => {
  for (const text of ['我看到 <foo', '我看到 <foo\n属性', '我看到 <foo\n\n更多']) {
    const encoded=serializeRoleplay([block('action', text),block('instruction','强制设为零')]);
    const parsed=parseRoleplay(encoded,'user');
    assert.deepEqual(parsed.instructionText,['强制设为零']);
    assert.ok(!parsed.narrativeText.includes('强制设为零'));
  }
});


test('unclosed HTML elements or comments in action do not conceal following instruction', () => {
  for (const text of ['我看到 <quest>', '我进入 <div>房间', '注释 <!-- ']) {
    const encoded=serializeRoleplay([block('action', text),block('instruction','改变剧情')]);
    const parsed=parseRoleplay(encoded,'user');
    assert.deepEqual(parsed.instructionText,['改变剧情']);
    assert.ok(!parsed.narrativeText.includes('改变剧情'));
  }
});


test('instruction containing unclosed code fences still round-trips as a complete instruction', () => {
  for (const text of ['```', '~~ 上文\n```js\n代码', '~~~\n未结束']) {
    const parsed = parseRoleplay(serializeRoleplay([block('instruction', text)]), 'user');
    assert.deepEqual(parsed.instructionText, [text]);
    assert.equal(parsed.narrativeText, '');
  }
});

test('projects SR-RP messages into ordered block-level Composer nodes', () => {
  const input = [
    block('action', '走进大厅，'),
    block('thought', '这里似乎有人来过。'),
    block('action', '他抬起头，'),
    block('speech', '有人吗？'),
    block('instruction', '加强环境描写'),
    block('instruction', '不要替玩家决定行动'),
  ];
  const projection = parseRoleplayForComposer(serializeRoleplay(input), 'user');
  assert.deepEqual(only(projection.blocks), only(input));
});

test('keeps inline quoted text inside an action block in the block Composer', () => {
  const projection = parseRoleplayForComposer('他说：“你好，世界。”然后转身离开。', 'user');
  assert.deepEqual(only(projection.blocks), [{kind:'action', text:'他说：“你好，世界。”然后转身离开。'}]);
});

test('preserves intentional empty action blocks between content blocks', () => {
  const input = [block('action', '第一段'), block('action', ''), block('action', '第二段')];
  const encoded = serializeRoleplay(input);
  assert.equal(encoded, '第一段\n\n\n\n第二段');
  assert.deepEqual(only(parseRoleplayForComposer(encoded, 'user').blocks), only(input));
});

test('preserves empty action blocks around instruction blocks without inventing separators', () => {
  const cases = [
    [block('action', '前文'), block('instruction', '指令'), block('action', '后文')],
    [block('action', '前文'), block('action', ''), block('instruction', '指令')],
    [block('instruction', '指令'), block('action', ''), block('action', '后文')],
    [block('instruction', '第一条'), block('action', ''), block('instruction', '第二条')],
  ];
  for (const input of cases) {
    assert.deepEqual(only(parseRoleplayForComposer(serializeRoleplay(input), 'user').blocks), only(input));
  }
});

test('trims only trailing empty lines and keeps middle blank lines', () => {
  assert.equal(trimTrailingEmptyRoleplayLines('前文\n\n\n\n后文\n\n'), '前文\n\n\n\n后文');
  assert.equal(trimTrailingEmptyRoleplayLines('前文\n\n'), '前文');
  assert.equal(trimTrailingEmptyRoleplayLines('前文\n\n\n  '), '前文');
  assert.equal(trimTrailingEmptyRoleplayLines('   \n\n'), '');
  assert.equal(trimTrailingEmptyRoleplayLines('前文  '), '前文  ');
});

test('normalizes punctuation-only action fragments after speech without swallowing narration', () => {
  const input = [block('action', '他说'), block('speech', '你好'), block('action', '！'), block('action', '他转身离开。'), block('action', '”')];
  assert.deepEqual(only(normalizeComposerBlocks(input)), [
    {kind:'action', text:'他说'},
    {kind:'speech', text:'你好！'},
    {kind:'action', text:'他转身离开。'},
    {kind:'action', text:'”'},
  ]);
});
