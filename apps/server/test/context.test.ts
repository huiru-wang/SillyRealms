import {expect,it} from 'vitest';
import {contextFixture} from './fixtures/context.js';
import {compileContext} from '../src/runtime/context/node-compiler.js';
import {resolveBudget} from '../src/domain/preset-budget.js';
it('compiles source-bound nodes in preset order with original history roles and post-input rules',()=>{
 const input=contextFixture(),context=compileContext(input),text=JSON.stringify(context.messages);
 for(const content of ['PLAYER','NPC','LORE','SESSION_BACKGROUND','SUMMARY','OLD_USER','OLD_STORY','CURRENT forest','奖励增加10'])expect(text).toContain(content);
 for(const content of ['GLOBAL_PRIVATE','PRIVATE_DESCRIPTION','HIDDEN','readonly_state','sr_extensions'])expect(text).not.toContain(content);
 const order=context.trace.filter(t=>t.messages.length).map(t=>t.nodeId);
 expect(order).toEqual(['main','personaInfo','characterInfo','worldInfo','chatHistory','userInput','worldState','actionSuggestions']);
 const history=context.trace.find(t=>t.nodeId==='chatHistory')!.messages;
 expect(history.map(m=>m.role)).toEqual(['system','user','assistant']);
 expect(context.activeRoots).toEqual(['score']);expect(context.postprocess.state_update.required).toBe(true);
 expect(Object.isFrozen(context.messages)).toBe(true);
});
it('node switches control prompt and parser together; no active root omits all state instructions',()=>{
 for(const state of [false,true])for(const suggestions of [false,true]){
  const input=contextFixture();input.nodes.find(n=>n.id==='worldState')!.enabled=state;input.nodes.find(n=>n.id==='actionSuggestions')!.enabled=suggestions;
  const context=compileContext(input),text=JSON.stringify(context.messages);
  expect(text.includes('<state_update>')).toBe(state);expect(text.includes('<action_suggestions>')).toBe(suggestions);
  expect(context.postprocess.state_update.enabled).toBe(state);expect(context.postprocess.action_suggestions.enabled).toBe(suggestions);
 }
 const input=contextFixture();input.world.state!.scopes.message!.score!.load={mode:'never'};
 const context=compileContext(input);expect(context.activeRoots).toEqual([]);expect(context.trace.find(t=>t.nodeId==='worldState')!.messages).toEqual([]);
 expect(context.messages.some(message=>typeof message.content==='string'&&message.content.startsWith('<世界状态>\n'))).toBe(false);
});
it('activation uses only supplied retained history and input',()=>{
 const input=contextFixture();input.input='continue';
 expect(JSON.stringify(compileContext(input).messages)).not.toContain('NPC');
 input.history.push({id:'recent',role:'user',text:'forest'});
 expect(JSON.stringify(compileContext(input).messages)).toContain('NPC');
 input.world.characters[0]!.load={mode:'never'};
 expect(JSON.stringify(compileContext(input).messages)).not.toContain('PLAYER');
});
it('caps numeric input budget at 80% and reserves output plus safety',()=>{
 const base={strategy:'rolling_summary' as const,max_context_tokens:160000,max_output_tokens:4096},model={contextWindow:200000,maxTokens:100000};
 expect(resolveBudget(base,model)).toEqual(base);
 expect(()=>resolveBudget({...base,max_context_tokens:160001},model)).toThrow();
 expect(()=>resolveBudget({...base,max_output_tokens:50000},model)).toThrow();
});
