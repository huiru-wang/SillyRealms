import {defaultPreset} from '../../src/domain/preset/schema.js';
import {parseCard} from '../../src/domain/world-card.js';
export function contextFixture(){
 const world=parseCard({spec:'world_card',spec_version:'0.1',data:{
  name:'test',characters:[
   {id:'p',name:'玩家',player_selectable:true,prompt:'PLAYER',description:'PRIVATE_DESCRIPTION'},
   {id:'npc',name:'NPC',prompt:'NPC',load:{mode:'on_mention',keywords:['forest']}},
  ],openings:[{id:'o',name:'Start',content:'start'}],
  lorebook:{entries:[{id:'l',content:'LORE',load:{mode:'always'}}]},
  state:{schema_version:1,scopes:{
   global:{hidden:{type:'string',initial:'GLOBAL_PRIVATE'}},
   session:{place:{type:'string',initial:'SESSION_BACKGROUND'}},
   message:{score:{type:'number',initial:0,min:0,max:100,description:'奖励增加10'},hidden:{type:'json',initial:{secret:'HIDDEN'},load:{mode:'never'}}},
  }},
 }}).data;
 return {world,playerId:'p',views:{global:{hidden:'GLOBAL_PRIVATE'},session:{place:'SESSION_BACKGROUND'},message:{score:0,hidden:{secret:'HIDDEN'}}},input:'CURRENT forest',nodes:defaultPreset().config_json.nodes,presetHash:'hash',history:[{id:'summary',role:'assistant' as const,text:'SUMMARY'},{id:'u',role:'user' as const,text:'OLD_USER'},{id:'a',role:'assistant' as const,text:'OLD_STORY'}]};
}
