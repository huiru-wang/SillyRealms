import { expect, it } from 'vitest';
import { buildContext } from '../src/agent/context.js';

it('uses literal content and freezes activation before history changes', () => {
  const world = { characters:[{id:'player',player_selectable:true,description:'{{user}}'},{id:'npc',description:'NPC',load:{mode:'on_mention',keywords:['forest']}}], lorebook:{entries:[{id:'entry',content:'LITERAL <% danger %>',load:{mode:'on_mention',keywords:['forest'],anchor:'characterInfo',position:'before'}}]} };
  const views = { global:{}, session:{}, message:{} };
  const nodes = [{id:'personaInfo',kind:'system' as const,role:'system' as const,enabled:true},{id:'characterInfo',kind:'system' as const,role:'system' as const,enabled:true},{id:'chatHistory',kind:'system' as const,role:'auto' as const,enabled:true},{id:'userInput',kind:'system' as const,role:'user' as const,enabled:true}];
  const context = buildContext(world,nodes,'player',views,[{role:'user',text:'forest'}],'hello');
  const messages = context.messages([]);
  expect(JSON.stringify(messages)).toContain('{{user}}');
  expect(JSON.stringify(messages)).toContain('LITERAL <% danger %>');
  expect(JSON.stringify(messages)).toContain('NPC');
  expect(messages.filter(m => m.role === 'user')).toHaveLength(1);
});
