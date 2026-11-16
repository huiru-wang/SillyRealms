import { expect, it } from 'vitest';
import { configSchema, defaultPreset, presetSchema, type PresetNode } from '../src/domain/preset/schema.js';
import { compileContext } from '../src/runtime/context/node-compiler.js';
import { contextFixture } from './fixtures/context.js';

const custom = (id: string, prompt = 'Custom ' + id): PresetNode => ({
  id, name: id, kind: 'text', role: 'system', enabled: true, prompt,
});

it('uses a single-level string-template contract and rejects the parts format', () => {
  const preset = defaultPreset();
  expect(preset.config_json.schemaVersion).toBe(3);
  expect(preset.config_json.nodes.every(node => typeof node.prompt === 'string')).toBe(true);
  expect(preset.config_json.nodes.find(node => node.id === 'chatHistory')!.prompt)
    .toBe('<已有摘要>\n{{history.summary}}\n</已有摘要>\n{{history.messages}}');
  const legacy: any = structuredClone(preset);
  legacy.config_json.schemaVersion = 2;
  legacy.config_json.nodes[0].prompt = { parts: [{ type: 'text', value: 'Old main' }] };
  expect(presetSchema.safeParse(legacy).success).toBe(false);
  legacy.config_json.schemaVersion = 3;
  expect(presetSchema.safeParse(legacy).success).toBe(false);
  const nested: any = structuredClone(preset);
  nested.config_json.nodes[0].children = [custom('nested')];
  expect(presetSchema.safeParse(nested).success).toBe(false);
});

it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])('accepts a custom node at full-list position %i and compiles it there', index => {
  const preset = defaultPreset();
  preset.config_json.nodes.splice(index, 0, custom('at-' + index));
  expect(presetSchema.safeParse(preset).success).toBe(true);
  const input = contextFixture();
  input.nodes = preset.config_json.nodes;
  const context = compileContext(input);
  expect(context.trace.map(row => row.nodeId)).toEqual(preset.config_json.nodes.map(node => node.id));
  expect(context.trace[index]!.messages[0]!.content).toBe('Custom at-' + index);
});

it('keeps the relative order of all built-in nodes including optional postprocess nodes', () => {
  const preset = defaultPreset();
  preset.config_json.nodes = preset.config_json.nodes.flatMap((node, index) => [custom('before-' + index), node]);
  expect(presetSchema.safeParse(preset).success).toBe(true);
  const main = preset.config_json.nodes.findIndex(node => node.id === 'main');
  const persona = preset.config_json.nodes.findIndex(node => node.id === 'personaInfo');
  [preset.config_json.nodes[main], preset.config_json.nodes[persona]] =
    [preset.config_json.nodes[persona]!, preset.config_json.nodes[main]!];
  expect(presetSchema.safeParse(preset).success).toBe(false);

  const changed = defaultPreset();
  const state = changed.config_json.nodes.findIndex(node => node.id === 'worldState');
  const suggestions = changed.config_json.nodes.findIndex(node => node.id === 'actionSuggestions');
  changed.config_json.nodes[state]!.enabled = false;
  [changed.config_json.nodes[state], changed.config_json.nodes[suggestions]] =
    [changed.config_json.nodes[suggestions]!, changed.config_json.nodes[state]!];
  expect(presetSchema.safeParse(changed).success).toBe(false);
  changed.config_json.nodes = changed.config_json.nodes.filter(node => node.kind !== 'postprocess');
  expect(presetSchema.safeParse(changed).success).toBe(true);
});

it('allows editing every prompt without tying ordinary variables to their old nodes', () => {
  const preset = defaultPreset();
  for (const node of preset.config_json.nodes) {
    if (node.id === 'chatHistory') node.prompt = '{{history.messages}}\nHistory suffix';
    else if (node.id === 'userInput') node.prompt = 'Input prefix\n{{input.text}}';
    else node.prompt = '';
  }
  preset.config_json.nodes.push(custom('materials',
    '{{user}}\n{{persona.prompt}}\n{{characters.prompts}}\n{{world.lore}}\n' +
    '{{history.summary}}{{history.summary}}\n{{state.currentValues}}\n{{state.updateRules}}'));
  expect(presetSchema.safeParse(preset).success).toBe(true);
});

it.each([
  '{{unknown.value}}', '{{session.background}}', '{{history.summary', '{{}}', '{{__proto__.value}}',
])('rejects invalid template %s even on a disabled custom node', prompt => {
  const preset = defaultPreset();
  preset.config_json.nodes.push({ ...custom('invalid', prompt), enabled: false });
  expect(presetSchema.safeParse(preset).success).toBe(false);
});

it('permits escaped literal braces but validates unescaped references', () => {
  const preset = defaultPreset();
  preset.config_json.nodes.push(custom('literal', '\\{{unknown.value}} and \\\\{{user}}'));
  expect(presetSchema.safeParse(preset).success).toBe(true);
});

it.each(['history.messages', 'input.text'])('keeps %s exactly once in its structural node', variable => {
  const id = variable === 'history.messages' ? 'chatHistory' : 'userInput';
  for (const prompt of ['', '{{' + variable + '}}{{' + variable + '}}']) {
    const preset = defaultPreset();
    preset.config_json.nodes.find(node => node.id === id)!.prompt = prompt;
    expect(presetSchema.safeParse(preset).success).toBe(false);
  }
  const preset = defaultPreset();
  preset.config_json.nodes.push(custom('misplaced', '{{' + variable + '}}'));
  expect(presetSchema.safeParse(preset).success).toBe(false);
});

it('retains built-in identity, required-node and unique-id checks', () => {
  const config = defaultPreset().config_json;
  const cases = [
    { ...config, nodes: config.nodes.filter(node => node.id !== 'personaInfo') },
    { ...config, nodes: config.nodes.map(node => node.id === 'main' ? { ...node, enabled: false } : node) },
    { ...config, nodes: config.nodes.map(node => node.id === 'chatHistory' ? { ...node, role: 'system' } : node) },
    { ...config, nodes: config.nodes.map(node => node.id === 'userInput' ? { ...node, kind: 'text' } : node) },
    { ...config, nodes: [...config.nodes, custom('main')] },
    { ...config, nodes: [...config.nodes, { ...custom('auto'), role: 'auto' }] },
  ];
  for (const candidate of cases) expect(configSchema.safeParse(candidate).success).toBe(false);
});
