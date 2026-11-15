import {expect,it} from 'vitest';
import {fromServer,presetPatch,getPresetValidationError} from '../../studio/src/features/presets/adapter.js';
const system=(id:string)=>({id,kind:'system',source:id,name:id,role:'system',enabled:true,content:id+' original'});
it('preserves system nodes, capability metadata and custom placement when adapting a preset',()=>{
 const raw={id:'p',name:'Preset',summary_prompt:'Summary',capabilities:{state_update:{enabled:false}},budget:{strategy:'sliding_window',max_context_tokens:12345,max_output_tokens:777},nodes:[system('main'),{id:'a',kind:'text',name:'A',role:'assistant',enabled:false,content:'text'},system('chatHistory'),system('worldState'),system('postHistory')]};
 const preset=fromServer(raw);expect(preset.maxContextTokens).toBe(12345);expect(preset.contextStrategy).toBe('sliding_window');
 preset.customNodes.push({id:'b',name:'B',role:'user',enabled:true,content:'new'});preset.style.content='new style';
 const patch=presetPatch(preset);
 expect(patch.nodes_order).toEqual(['main','a','b','chatHistory','worldState','postHistory']);
 expect(patch.nodes).not.toContainEqual(expect.objectContaining({id:'worldState'}));
 expect(patch).not.toHaveProperty('capabilities');expect(patch.budget.max_context_tokens).toBe(12345);
 expect(raw.nodes[3]?.content).toBe('worldState original');expect(getPresetValidationError(preset)).toBeNull();
 preset.maxContextTokens=1;expect(getPresetValidationError(preset)).toBeTruthy();
});
