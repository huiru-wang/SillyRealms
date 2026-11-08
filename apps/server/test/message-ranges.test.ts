import {expect,it} from 'vitest';
import {canInsertMatch,canShowLiteralPlaceholder,protectedRanges} from '../../../packages/sr-sdk/src/message-ranges.js';
import type {MessageMatch} from '../../../packages/sr-sdk/src/story-types.js';
const match=(text:string,start:number,end:number):MessageMatch=>({start,end,ruleId:'x',match:text.slice(start,end),replacement:{type:'component',component:'Example'},groups:[],namedGroups:{}});
it('allows complete placeholder tags while protecting code and HTML attributes',()=>{
 const text='<KaidanCoverImpl/>\n\n`[选项:查看]`\n\n<a title="[选项:其他]">链接</a>';
 const spans=protectedRanges(text);
 expect(canInsertMatch(match(text,0,'<KaidanCoverImpl/>'.length),spans)).toBe(true);
 const inCode=text.indexOf('[选项:查看]');expect(canInsertMatch(match(text,inCode,inCode+7),spans)).toBe(false);
 const inTag=text.indexOf('[选项:其他]');expect(canInsertMatch(match(text,inTag,inTag+7),spans)).toBe(false);
});
it('can preserve an invalid block placeholder as text without altering code spans',()=>{
 const text='**文本<Card/>结尾** 与 `<Card/>`';const spans=protectedRanges(text);
 const first=text.indexOf('<Card/>'),second=text.lastIndexOf('<Card/>');
 expect(canShowLiteralPlaceholder(match(text,first,first+7),spans)).toBe(true);
 expect(canShowLiteralPlaceholder(match(text,second,second+7),spans)).toBe(false);
});
it('allows text inside emphasis but rejects a match cutting its delimiters',()=>{
 const text='她说：**重要[选项:纸条]内容**，然后离开。';const spans=protectedRanges(text);
 const choice=text.indexOf('[选项:纸条]');expect(canInsertMatch(match(text,choice,choice+7),spans)).toBe(true);
 expect(canInsertMatch(match(text,choice,choice+7),spans,'block')).toBe(false);
 const start=text.indexOf('**');expect(canInsertMatch(match(text,start,choice+7),spans)).toBe(false);
});
it('protects heading and list syntax while allowing visible text matches',()=>{
 const text='# 标题 [选项:甲]\n\n- 内容 [选项:乙]';const spans=protectedRanges(text);
 expect(canInsertMatch(match(text,0,2),spans)).toBe(false);
 const first=text.indexOf('[选项:甲]');expect(canInsertMatch(match(text,first,first+6),spans)).toBe(true);
 const marker=text.indexOf('- 内容');expect(canInsertMatch(match(text,marker,marker+2),spans)).toBe(false);
});
it('keeps inline HTML containers valid around component replacements',()=>{
 const text='她说 <a href="/">[选项:甲]</a> 然后离开';const spans=protectedRanges(text);
 const first=text.indexOf('[选项:甲]');
 expect(canInsertMatch(match(text,first,first+6),spans,'inline')).toBe(true);
 expect(canInsertMatch(match(text,first,first+6),spans,'block')).toBe(false);
 const open=text.indexOf('<a ');expect(canInsertMatch(match(text,open,text.indexOf('>')+1),spans)).toBe(false);
});
