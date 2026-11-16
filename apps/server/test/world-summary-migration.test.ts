import {expect,it} from 'vitest';
import {parseCard} from '../src/domain/world-card.js';

it('drops the retired world summary on import without changing prose',()=>{
 const card=parseCard({spec:'world_card',spec_version:'0.1',data:{name:'World',summary:'discard',description:{type:'component',component:'Intro'},components:[{id:'Intro',component:'export default ()=>null'}],characters:[{id:'p',name:'Player',player_selectable:true}],openings:[{id:'o',name:'Opening',content:'keep opening'}]}});
 expect(card.data).not.toHaveProperty('summary');expect(card.data.description).toEqual({type:'component',component:'Intro'});
});
