import {expect,it} from 'vitest';
import {defaultPreset,presetSchema} from '../src/domain/preset/schema.js';
import {fromServer,presetPatch,getPresetValidationError} from '../../studio/src/features/presets/adapter.js';
it('round trips every fixed prompt and exposes switches while preserving custom node order',()=>{
 const raw={...defaultPreset(),id:'p',etag:'v1'},preset=fromServer(raw);
 preset.customNodes.push({id:'a',name:'A',role:'assistant',enabled:false,content:'custom'});
 preset.style.content='new main';preset.raw.config_json.nodes.find((n:any)=>n.id==='worldState').enabled=false;
 const patch=presetPatch(preset);expect(presetSchema.safeParse(patch).success).toBe(true);
 expect(patch.config_json.nodes.map(n=>n.id)).toEqual(['main','a','personaInfo','characterInfo','worldInfo','chatHistory','userInput','worldState','actionSuggestions']);
 expect(patch.config_json.nodes.find(n=>n.id==='worldState')).toEqual(preset.raw.config_json.nodes.find((n:any)=>n.id==='worldState'));
 expect(patch.config_json.nodes[0].prompt.parts[0].value).toBe('new main');expect(getPresetValidationError(preset)).toBeNull();
 preset.summaryPrompt='';expect(getPresetValidationError(preset)).toBeTruthy();
});
