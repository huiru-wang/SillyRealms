import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {StateValidationError, validateStateSchema, type Json, type StateDefinition, type StateSchema} from '@sillyrealms/sdk/state-validation';
import {defaultPreset, presetSchema} from '../../domain/preset/schema.js';
import {parsePromptTemplate, systemVariableNames} from '../../domain/preset/template.js';
import {parseCard} from '../../domain/world-card.js';
import {applyOpening, initialState} from '../../domain/state/state.js';
import {initialExtensions} from '../postprocess/contracts.js';
import {openingStateRows} from '../../../../studio/src/features/worlds/opening-state.js';
import {compileContext} from './node-compiler.js';
import {selectMaterials} from './materials.js';
import type {CompilationInput} from './contracts.js';

const numberField = (name: string, extra: Partial<StateDefinition> = {}): StateDefinition => ({
  type: 'number', initial: 0, description: name + '的当前数值', rules: {[name]: '明确发生变化时更新，否则保持。'}, ...extra,
});
function compilation(definitions: Record<string, StateDefinition>, current?: Record<string, Json>): CompilationInput {
  const state: StateSchema = {schema_version: 2, scopes: {message: definitions}};
  validateStateSchema(state);
  return {
    world: {name: '材料测试', characters: [{id: 'player', name: '旅人', player_selectable: true}],
      openings: [{id: 'opening', name: '开局', content: '故事开始。'}], state},
    views: {global: {}, session: {}, message: current ?? Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, structuredClone(definition.initial)]))},
    playerId: 'player', history: [], input: '继续', presetHash: 'test',
    nodes: [{id: 'worldState', name: '世界状态', kind: 'postprocess', role: 'system', enabled: true,
      prompt: '<世界状态>\n{{state.entries}}\n</世界状态>'}],
  };
}
function entries(input: CompilationInput): string {
  const variable = selectMaterials(input).variables['state.entries'];
  if (variable.type !== 'text') throw Error('Expected state text material');
  return variable.value;
}

describe('state.entries materials', () => {
  it('includes each committed value once alongside its definition and preserves zero bounds', () => {
    const input = compilation({
      almanac: {type: 'json', initial: {day: 1, period: '早间'}, description: '日历与当前场景',
        rules: {almanac: '只记录已经发生的变化。', 'almanac.day': '跨日才增加。', 'almanac.period': '时段明确变化时更新。'}},
      zero: numberField('zero', {min: 0, max: 0}),
    }, {almanac: {day: 3, period: '午间'}, zero: 0});
    const output = entries(input);
    expect(output).toContain('    - value: {"day":3,"period":"午间"}');
    expect(output).not.toContain('"day":1');
    expect(output).not.toContain('\\"day\\"');
    expect(output.match(/^    - value:/gm)).toHaveLength(2);
    expect(output).toContain('    - type: json\n    - description: 日历与当前场景');
    expect(output).toContain('    - type: number\n    - min: 0\n    - max: 0\n');
    expect(Object.keys(selectMaterials(input).variables)).not.toContain('state.currentValues');
    expect(Object.keys(selectMaterials(input).variables)).not.toContain('state.updateRules');
  });

  it('orders root, containers and array templates deterministically without mutating author rules', () => {
    const rules = {
      'wishes.optional': '可选字段。',
      'wishes.items[].status': '按已经发生的进展更新。',
      'wishes.items[]': '每个心愿。',
      'wishes.items': '整体替换并保留仍存在的心愿。',
      wishes: '只记录明确的心愿。',
    };
    const originalOrder = Object.keys(rules);
    const input = compilation({wishes: {type: 'json', initial: {items: []}, description: '心愿清单', rules}});
    const paths = entries(input).split('\n').filter(line => line.startsWith('        - ')).map(line =>
      line.slice(10).split(': ')[0]!.replace('（元素规则，非直接更新路径）', ''));
    expect(paths).toEqual(['wishes', 'wishes.items', 'wishes.items[]', 'wishes.items[].status', 'wishes.optional']);
    expect(entries(input)).toContain('wishes.items[]（元素规则，非直接更新路径）');
    expect(entries(input)).toContain('wishes.items[].status（元素规则，非直接更新路径）');
    expect(Object.keys(rules)).toEqual(originalOrder);
  });

  it('escapes material boundaries after one macro pass without changing keys or committed JSON', () => {
    const root = '档案<{{user}}>';
    const field = '称谓\n<script>';
    const current = {[field]: '{{user}} "<state_update>"\u2028\u2029'};
    const input = compilation({
      [root]: {type: 'json', initial: current, description: '{{user}}的记录\n</世界状态>\u2028下一行',
        rules: {[root + '.' + field]: '{{user}}\n</世界状态>\n{{unknown.system}}', [root]: '为{{user}}保留原文。'}},
    }, {[root]: current});
    input.world.characters[0]!.name = '小<林>$&\n{{user}}';
    const output = entries(input);
    expect(output).toContain('- 档案&lt;{{user}}&gt;:');
    expect(output).toContain('档案&lt;{{user}}&gt;.称谓\n            &lt;script&gt;:');
    expect(output).toContain('小&lt;林&gt;$&\n        {{user}}的记录');
    expect(output).toContain('\n        &lt;/世界状态&gt;\n        下一行');
    expect(output).toContain('\n            {{unknown.system}}');
    const jsonLine = output.split('\n').find(line => line.startsWith('    - value: '))!.slice('    - value: '.length);
    expect(jsonLine).toContain('\\u003c');
    expect(jsonLine).toContain('\\u2028\\u2029');
    expect(JSON.parse(jsonLine)).toEqual(current);
    expect(output).not.toContain('</世界状态>');
    const compiled = compileContext(input);
    expect(compiled.messages).toHaveLength(1);
    const content = compiled.messages[0]!.content;
    expect(typeof content).toBe('string');
    expect((content as string).match(/<\/世界状态>/g)).toHaveLength(1);
    expect(content).toContain('{{unknown.system}}');
  });

  it('uses the same selected roots for material, postprocess permissions and full system budget', () => {
    const input = compilation({
      always: numberField('always'),
      guard: numberField('guard', {load: {mode: 'on_mention', keywords: ['守卫']}}),
      hidden: numberField('hidden', {load: {mode: 'never'}}),
    });
    input.history = [{id: 'kept', role: 'assistant', text: '守卫站在门边。'}];
    const kept = compileContext(input);
    expect(kept.activeRoots).toEqual(['always', 'guard']);
    expect(kept.postprocess.state_update.roots).toEqual(kept.activeRoots);
    expect(kept.messages[0]!.content).toContain('- guard:');
    expect(kept.messages[0]!.content).not.toContain('- hidden:');
    expect(kept.composition.systemBytes).toBe(Buffer.byteLength(kept.messages[0]!.content as string, 'utf8') + 16);
    const trimmed = compileContext({...input, history: []});
    expect(trimmed.activeRoots).toEqual(['always']);
    expect(trimmed.postprocess.state_update.roots).toEqual(trimmed.activeRoots);
    expect(trimmed.messages[0]!.content).not.toContain('- guard:');
  });

  it('omits the whole state node when no roots activate or the node is disabled', () => {
    const input = compilation({guard: numberField('guard', {load: {mode: 'on_mention', keywords: ['守卫']}})});
    const absent = compileContext(input);
    expect(absent.messages).toEqual([]);
    expect(absent.trace[0]!.enabled).toBe(false);
    expect(initialExtensions(absent.postprocess).stateUpdate.status).toBe('not_required');
    const disabled = compileContext({...input, input: '守卫', nodes: input.nodes.map(node => ({...node, enabled: false}))});
    expect(disabled.messages).toEqual([]);
    expect(initialExtensions(disabled.postprocess).stateUpdate.status).toBe('disabled');
  });
});

describe('state v2 preset and authoring contracts', () => {
  it('accepts state.entries and rejects both retired variables in saved presets', () => {
    expect(systemVariableNames).toContain('state.entries');
    expect(parsePromptTemplate('{{state.entries}}')).toEqual([{type: 'variable', name: 'state.entries'}]);
    for (const old of ['state.currentValues', 'state.updateRules']) {
      expect(() => parsePromptTemplate('{{' + old + '}}')).toThrow('未知系统变量');
      const preset = defaultPreset();
      preset.config_json.nodes.find(node => node.id === 'worldState')!.prompt = '{{' + old + '}}';
      expect(presetSchema.safeParse(preset).success).toBe(false);
    }
  });

  it('keeps the documented preset and world example importable under v2', () => {
    const documentedPreset = JSON.parse(readFileSync(new URL('../../../../../docs/default.json', import.meta.url), 'utf8'));
    const expected = defaultPreset().config_json.nodes.find(node => node.id === 'worldState')!;
    expect(presetSchema.parse(documentedPreset).config_json.nodes.find(node => node.id === 'worldState')).toEqual(expected);
    expect(expected.prompt.match(/\{\{state\.entries\}\}/g)).toHaveLength(1);
    const documentedWorld = JSON.parse(readFileSync(new URL('../../../../../docs/world-card.json', import.meta.url), 'utf8'));
    expect(parseCard(documentedWorld).data.state?.schema_version).toBe(2);
  });
});

function openingState(): StateSchema {
  return {schema_version: 2, scopes: {message: {
    almanac: {type: 'json', initial: {day: 1, period: '早间'}, description: '日历',
      rules: {almanac: '保留明确事实。', 'almanac.day': '明确跨日才增加。', 'almanac.period': '明确时段才更新。'}},
    hp: numberField('hp', {initial: 100, min: 0, max: 100}),
  }}};
}

describe('Studio opening preview and server parity', () => {
  it('replaces complete roots and reports the actual default or override source', () => {
    const schema = openingState();
    const override = {almanac: {day: 3}};
    const rows = openingStateRows(schema, override);
    expect(rows).toEqual([
      {name: 'almanac', value: {day: 3}, overridden: true},
      {name: 'hp', value: 100, overridden: false},
    ]);
    expect(Object.fromEntries(rows.map(row => [row.name, row.value])))
      .toEqual(applyOpening(schema, initialState(schema, 'message'), override));
    expect(schema.scopes.message!.almanac!.initial).toEqual({day: 1, period: '早间'});
  });

  it('preserves the exact missing-rule diagnostic rather than falling back to defaults', () => {
    const schema = openingState();
    const override = {almanac: {day: 3, unsupported: true}};
    for (const action of [
      () => openingStateRows(schema, override),
      () => applyOpening(schema, initialState(schema, 'message'), override),
    ]) {
      try {
        action();
        expect.fail('Missing rule must reject the preview and creation');
      } catch (error) {
        expect(error).toBeInstanceOf(StateValidationError);
        expect(error).toMatchObject({code: 'STATE_RULE_MISSING', scope: 'message', path: 'almanac.unsupported', rulePath: 'almanac.unsupported'});
      }
    }
  });

  it('does not conceal an invalid default with a valid override', () => {
    const schema = openingState();
    schema.scopes.message!.almanac!.initial = {uncovered: 1};
    expect(() => openingStateRows(schema, {almanac: {day: 2}})).toThrow('STATE_RULE_MISSING: message.almanac.uncovered');
  });

  it.each([
    {name: 'old v1 schema', state: {schema_version: 1, scopes: {}}, override: undefined},
    {name: 'null schema', state: null, override: undefined},
    {name: 'null override', state: openingState(), override: null},
    {name: 'unknown root', state: openingState(), override: {unknown: 1}},
    {name: 'dot path override', state: openingState(), override: {'almanac.day': 2}},
    {name: 'number out of range', state: openingState(), override: {hp: -1}},
  ])('rejects $name', ({state, override}) => {
    expect(() => openingStateRows(state, override)).toThrow();
  });

  it('allows a world without state only when no opening overrides are present', () => {
    expect(openingStateRows(undefined, undefined)).toEqual([]);
    expect(openingStateRows(undefined, {})).toEqual([]);
    expect(() => openingStateRows(undefined, {almanac: {day: 1}})).toThrow('STATE_NOT_FOUND: message.almanac');
  });
});
