import {expect,it} from 'vitest';
import {defaultPreset,presetSchema} from '../src/domain/preset/schema.js';
import {fromServer,presetPatch,getPresetValidationError} from '../../studio/src/features/presets/adapter.js';
import type {PresetNode} from '../../studio/src/features/presets/types.js';

const custom=(id:string,prompt='{{user}} 的补充规则'):PresetNode=>({id,name:id,kind:'text',role:'assistant',enabled:true,prompt});

it('round trips a single ordered node array with custom prompts before, between and after builtins',()=>{
 const raw={...defaultPreset(),id:'p',etag:'v1'},preset=fromServer(raw);
 preset.nodes.unshift(custom('before-main'));
 preset.nodes.splice(preset.nodes.findIndex(n=>n.id==='worldInfo'),0,custom('before-world'));
 preset.nodes.splice(preset.nodes.findIndex(n=>n.id==='worldState'),0,custom('after-input'));
 preset.nodes.push(custom('last','{{history.summary}}'));
 preset.nodes.find(n=>n.id==='main')!.prompt='新的叙事风格 {{persona.prompt}}';
 preset.nodes.find(n=>n.id==='worldInfo')!.prompt='世界资料：{{world.lore}}';
 preset.nodes.find(n=>n.id==='chatHistory')!.prompt='<摘要>\n{{history.summary}}\n</摘要>\n{{history.messages}}';
 preset.nodes.find(n=>n.id==='userInput')!.prompt='本轮请求：{{input.text}}';
 preset.nodes.find(n=>n.id==='worldState')!.enabled=false;
 const patch=presetPatch(preset);
 expect(patch.config_json.schemaVersion).toBe(3);
 expect(patch.config_json.nodes.map(n=>n.id)).toEqual(['before-main','main','personaInfo','characterInfo','before-world','worldInfo','chatHistory','userInput','after-input','worldState','actionSuggestions','last']);
 expect(patch.config_json.nodes).toEqual(preset.nodes);
 expect(presetSchema.safeParse(patch).success).toBe(true);
 expect(getPresetValidationError(preset)).toBeNull();
 expect(raw.config_json.nodes[0]!.prompt).not.toBe(preset.nodes.find(n=>n.id==='main')!.prompt);
 const reread=fromServer({...patch,id:'p',etag:'v2'});
 expect(presetPatch(reread)).toEqual(patch);
});

it('rejects changed builtin order including postprocess nodes without sorting the draft',()=>{
 const preset=fromServer({...defaultPreset(),id:'p',etag:'v1'});
 const first=preset.nodes.findIndex(n=>n.id==='personaInfo'),second=preset.nodes.findIndex(n=>n.id==='worldInfo');
 [preset.nodes[first],preset.nodes[second]]=[preset.nodes[second]!,preset.nodes[first]!];
 const order=preset.nodes.map(n=>n.id);
 expect(getPresetValidationError(preset)).toBe('请保持系统节点的先后顺序。');
 expect(presetPatch(preset).config_json.nodes.map(n=>n.id)).toEqual(order);
 const post=fromServer({...defaultPreset(),id:'p',etag:'v1'});
 const state=post.nodes.findIndex(n=>n.id==='worldState'),suggestions=post.nodes.findIndex(n=>n.id==='actionSuggestions');
 [post.nodes[state],post.nodes[suggestions]]=[post.nodes[suggestions]!,post.nodes[state]!];
 expect(getPresetValidationError(post)).toBe('请保持系统节点的先后顺序。');
});

it('preserves empty ordinary prompts and validates required identities without changing model parameters',()=>{
 const preset=fromServer({...defaultPreset(),id:'p',etag:'v1'});
 preset.nodes.find(n=>n.id==='main')!.prompt='';
 preset.nodes.push(custom('empty',''));
 preset.temperature=.65;preset.thinkingEnabled=true;
 expect(getPresetValidationError(preset)).toBeNull();
 expect(presetSchema.safeParse(presetPatch(preset)).success).toBe(true);
 expect(presetPatch(preset).model_parameters).toEqual({temperature:.65,thinking_enabled:true});
 preset.nodes.find(n=>n.id==='main')!.enabled=false;
 expect(getPresetValidationError(preset)).toBeTruthy();
 preset.nodes.find(n=>n.id==='main')!.enabled=true;
 preset.nodes.push(custom('main'));
 expect(getPresetValidationError(preset)).toBeTruthy();
 preset.nodes.pop();preset.summaryPrompt='';
 expect(getPresetValidationError(preset)).toBe('压缩提示词不能为空。');
});
