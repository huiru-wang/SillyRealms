import {expect,it} from 'vitest';
import {matchMessage} from '../../../packages/sr-sdk/src/message-matching.js';
import {selectMessageMatches} from '../../../packages/sr-sdk/src/message-ranges.js';
import type {MessageRule} from '../../../packages/sr-sdk/src/story-types.js';
const rule=(id:string,pattern:string,flags='g'):MessageRule=>({id,roles:['assistant'],pattern,flags,replacement:{type:'component',component:'Example'}});
it('extracts repeated named and numbered captures while respecting rule priority',()=>{
 const rules=[rule('choice','\\[选项:(?<text>[^\\]]+)\\]'),rule('later','甲')];
 const text='[选项:甲] [选项:乙]';
 const matches=selectMessageMatches(text,matchMessage(text,'assistant',rules),rules,{});
 expect(matches.map(item=>({rule:item.ruleId,whole:item.match,first:item.groups[0],name:item.namedGroups.text}))).toEqual([
  {rule:'choice',whole:'[选项:甲]',first:'甲',name:'甲'}, {rule:'choice',whole:'[选项:乙]',first:'乙',name:'乙'},
 ]);
 expect(matchMessage('[选项:甲]','user',[rule('choice','甲')])).toEqual([]);
});
it('ignores a whole zero-width rule without blocking later valid rules',()=>{
 const events:Array<{event:string;invalid:boolean|undefined}>=[];
 const matches=matchMessage('abc','assistant',[rule('empty','a*'),rule('letter','b')],(event,invalid)=>events.push({event,invalid}));
 expect(matches.map(item=>item.match)).toEqual(['b']);expect(events).toContainEqual({event:'end',invalid:true});
});
it('allows a later valid match when the earlier overlapping match crosses protected code',()=>{
 const text='`code`选项';const rules=[rule('cross','`code`选项'),rule('valid','选项')];
 expect(selectMessageMatches(text,matchMessage(text,'assistant',rules),rules,{}).map(item=>item.ruleId)).toEqual(['valid']);
});
