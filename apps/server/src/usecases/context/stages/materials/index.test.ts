import { describe, expect, it, vi } from 'vitest';
import { StateService } from '../../../../modules/state/service.js';
import { selectNarrativeMaterials, type MaterialSources } from './index.js';

const conditions = { evaluateWhen: StateService.prototype.evaluateWhen };
function sources(): MaterialSources {
  return {
    locale: 'zh-CN',
    world: {
      id: 'world', revision: 1, specVersion: '0.1', name: 'World', description: null, cover: null,
      characters: [{ id: 'player', name: 'Robin', player_selectable: true, prompt: 'You are {{user}}.' }],
      openings: [], lorebook: null, stateDefinition: null, messageRender: null, components: null,
      stageComponent: null, extensions: null, coverMosaicEnabled: false, defaultPresetId: null, defaultReplyAssistPresetId: null, defaultApiModelConfigId: null,
      state: {}, tags: [], createdAt: 0, updatedAt: 0,
    },
    playerId: 'player', inputText: 'Enter the harbor',
    history: [{ id: 'a', role: 'assistant', text: 'The manor is nearby.', timestamp: 1 }],
    views: { global: { day: 2 }, session: { unlocked: true }, message: { coins: 5 } },
  };
}
function variable(input: MaterialSources, name: 'persona.prompt' | 'characters.prompts' | 'world.lore' | 'state.message' | 'state.update.message') {
  const value = selectNarrativeMaterials(input, conditions).variables[name];
  if (value.type !== 'text') throw new Error('Expected text variable');
  return value.value;
}

describe('narrative material selection', () => {
  it('renders only supplied message rules without changing writable roots or revalidating stored paths', () => {
    const input = sources();
    const field = { type: 'json', initial: { items: [] }, description: 'Inventory' };
    input.world.stateDefinition = { schema_version: 2, scopes: { message: {
      bag: field, box: { ...field, rules: {} }, pack: { ...field, rules: { 'pack.items[]': 'Item' } },
    } } };
    const materials = selectNarrativeMaterials(input, conditions);
    expect(materials.activeRoots).toEqual(['bag', 'box', 'pack']);
    expect(String(materials.variables['state.update.message'].value).match(/- rules:/g)).toHaveLength(1);
    expect(materials.variables['state.message'].value).not.toContain('rules:');
    expect(materials.variables['state.update.message'].value).toContain('- bag:\n- box:\n- pack:');
    expect(materials.variables['state.update.message'].value).toContain('pack.items[]（元素规则，非直接更新路径）: Item');
    input.world.stateDefinition = { schema_version: 2, scopes: { message: {
      pack: { ...field, rules: { 'legacy.label': 'Already stored' } },
    } } };
    expect(variable(input, 'state.update.message')).toContain('legacy.label: Already stored');
  });

  it('renders falsy facts literally and reserves the type label for message JSON', () => {
    const input = sources();
    const fields = {
      coins: { type: 'number', initial: 0, min: 0, max: 10, description: 'Coins' },
      open: { type: 'boolean', initial: false, description: 'Open' },
      box: { type: 'json', initial: null, description: 'Box' },
    };
    input.world.stateDefinition = { schema_version: 2, scopes: { global: fields, session: fields, message: fields } };
    for (const snapshot of Object.values(input.views)) Object.assign(snapshot, { coins: 0, open: false, box: null });
    const { variables } = selectNarrativeMaterials(input, conditions);
    for (const scope of ['state.global', 'state.session', 'state.message'] as const) {
      const facts = variables[scope].value;
      expect(facts).toContain('value: 0');
      expect(facts).toContain('value: false');
      expect(facts).toContain('value: null');
      expect(facts).not.toMatch(/rules:|min:|max:|type: (?:number|boolean)/);
      expect(String(facts).includes('type: json')).toBe(scope === 'state.message');
    }
    expect(variables['state.update.message'].value).toBe('- coins:\n- open:\n- box:');
  });

  it('interpolates only original author prompts and keeps state descriptions literal', () => {
    const input = sources();
    const prompt = '名={{user}}/代号={{state.session.人设.代号}}/城市={{state.global.day}}/钱={{state.message.coins}}';
    input.world.characters = [
      { id: 'player', name: '{{state.message.coins}}', player_selectable: true, prompt },
      { id: 'npc', name: 'NPC', prompt },
    ];
    input.world.lorebook = { entries: [{ id: 'lore', content: prompt + '{{ weather.today }}' }] };
    input.world.stateDefinition = { schema_version: 2, scopes: {
      session: { 人设: { type: 'json', initial: { 代号: '' }, description: 'ID', rules: { 人设: 'profile', '人设.代号': 'name' } } },
      global: { day: { type: 'number', initial: 1, description: 'Day', rules: { day: 'day' } } },
      message: { coins: { type: 'number', initial: 0, description: '{{state.global.day}}', rules: { coins: 'coins' } } },
    } };
    input.views.session.人设 = { 代号: '<{{user}}>' };
    input.views.message.coins = 0;
    const result = selectNarrativeMaterials(input, conditions);
    const expected = '名={{state.message.coins}}/代号=&lt;{{user}}&gt;/城市=2/钱=0';
    expect(result.variables['persona.prompt'].value).toBe(expected);
    expect(result.variables['characters.prompts'].value).toBe(expected);
    expect(result.variables['world.lore'].value).toBe(expected + '{{ weather.today }}');
    expect(result.variables['state.message'].value).toContain('description: {{state.global.day}}');
    expect(result.activeRoots).toEqual(['coins']);
  });

  it('keeps enabled/load rules, role exclusion and stable author order while replacing user macros once', () => {
    const input = sources();
    input.world.characters.push(
      { id: 'later', name: 'Later', order: 2, prompt: 'Second {{user}}', load: { mode: 'on_mention', keywords: ['manor', 'harbor'], keyword_logic: 'all' } },
      { id: 'early', name: 'Early', order: 1, prompt: 'First <{{user}}>', load: { when: 'getState("unlocked") && getState("coins") >= 5' } },
      { id: 'tie', name: 'Tie', order: 2, prompt: 'Third', load: { mode: 'always' } },
      { id: 'disabled', name: 'Disabled', enabled: false, prompt: 'Disabled must not appear' },
      { id: 'never', name: 'Never', prompt: 'Never must not appear', load: { mode: 'never' } },
      { id: 'excluded', name: 'Excluded', prompt: 'Excluded must not appear', load: { mode: 'on_mention', keywords: ['harbor'], exclude_keywords: ['manor'] } },
    );
    expect(variable(input, 'persona.prompt')).toBe('You are Robin.');
    expect(variable(input, 'characters.prompts')).toBe('First &lt;Robin&gt;\n\nSecond Robin\n\nThird');
    input.world.characters[0] = { id: 'player', name: 'Robin', player_selectable: true, prompt: 'Hidden player', load: { mode: 'never' } };
    expect(variable(input, 'persona.prompt')).toBe('');
  });

  it('applies lore load order, keyword logic, exclusions and read-only condition failures', () => {
    const input = sources();
    input.world.lorebook = { entries: [
      { id: 'second', content: 'Later', load: { order: 2, mode: 'on_mention', keywords: ['absent', 'harbor'], keyword_logic: 'any' } },
      { id: 'first', content: 'Hello {{user}}', load: { order: 1, when: 'getState("day", {scope:"global"}) === 2' } },
      { id: 'disabled', content: 'Disabled', enabled: false },
      { id: 'false', content: 'False', load: { when: 'getState("coins") < 0' } },
      { id: 'bad', content: 'Bad', load: { when: 'getState("missing") > 0' } },
    ] };
    const materials = selectNarrativeMaterials(input, conditions);
    expect(materials.variables['world.lore']).toEqual({ type: 'text', value: 'Hello Robin\n\nLater' });
    expect(materials.diagnostics).toEqual([{ id: 'bad', reason: 'when_evaluation_failed', path: 'lorebook.bad' }]);
    expect(input.views.message).toEqual({ coins: 5 });
  });

  it('ignores user instruction blocks when matching activation keywords', () => {
    const input = sources();
    input.inputText = '<sr_instruction>\nsecret trigger\n</sr_instruction>\n\nLook around';
    input.world.lorebook = { entries: [
      { id: 'secret', content: 'Must stay inactive', load: { mode: 'on_mention', keywords: ['secret trigger'] } },
      { id: 'action', content: 'Active', load: { mode: 'on_mention', keywords: ['Look around'] } },
    ] };
    expect(variable(input, 'world.lore')).toBe('Active');
    expect(selectNarrativeMaterials(input, conditions).variables['input.text']).toEqual({ type: 'text', value: input.inputText });
  });

  it('exposes active state declarations and existing values without initializing absent roots or emitting updates', () => {
    const input = sources();
    input.world.stateDefinition = { schema_version: 2, scopes: { message: {
      coins: { type: 'number', initial: 0, min: 0, description: 'Coins for {{user}}', rules: { coins: 'Only actual changes.' } },
      absent: { type: 'string', initial: 'Do not initialize this', description: 'Missing snapshot', rules: { absent: 'A rule' } },
      hidden: { type: 'boolean', initial: false, description: 'Hidden', rules: { hidden: 'A rule' }, load: { mode: 'never' } },
    } } };
    const materials = selectNarrativeMaterials(input, conditions);
    expect(materials.activeRoots).toEqual(['coins', 'absent']);
    const text = variable(input, 'state.message');
    expect(text).toContain('value: 5');
    expect(text).toContain('Coins for Robin');
    expect(text).toContain('未设置（当前快照无此状态）');
    expect(text).not.toContain('Do not initialize this');
    expect(text).not.toContain('<state_update>');
    expect(input.views.message).toEqual({ coins: 5 });
  });

  it('filters identically named roots independently and only exposes message rules for writing', () => {
    const input = sources();
    const field = { type: 'string', initial: 'Initial', description: 'Current name', rules: { name: 'Write rule' } };
    input.world.stateDefinition = { schema_version: 2, scopes: {
      global: { name: { ...field, load: { mode: 'on_mention', keywords: ['harbor'] } } },
      session: { name: { ...field, load: { when: 'getState("unlocked", {scope:"session"})' } } },
      message: { name: field },
    } };
    input.views.global.name = 'World name';
    input.views.session.name = 'Player name';
    input.views.message.name = 'Local name';
    const { variables, activeRoots } = selectNarrativeMaterials(input, conditions);
    expect(variables['state.global'].value).toContain('World name');
    expect(variables['state.session'].value).toContain('Player name');
    expect(variables['state.session'].value).not.toContain('Write rule');
    expect(variables['state.message'].value).toContain('Local name');
    expect(variables['state.message'].value).not.toContain('Write rule');
    expect(variables['state.update.message'].value).toContain('Write rule');
    expect(activeRoots).toEqual(['name']);
    input.inputText = 'Elsewhere';
    input.views.session.unlocked = false;
    const filtered = selectNarrativeMaterials(input, conditions);
    expect(filtered.variables['state.global'].value).toBe('');
    expect(filtered.variables['state.session'].value).toBe('');
    expect(filtered.activeRoots).toEqual(['name']);
  });

  it('records names, rules and the actual keyword/when outcomes without reevaluating conditions or copying material content', () => {
    const input = sources();
    input.world.characters.push(
      { id: 'visitor', name: 'Visitor', prompt: 'PRIVATE_CHARACTER_PROMPT', load: {
        mode: 'on_mention', keywords: ['harbor', 'manor'], keyword_logic: 'all', when: 'getState("coins") >= 5',
      } },
      { id: 'disabled', name: 'Disabled', enabled: false, prompt: 'PRIVATE_DISABLED_PROMPT', load: { when: 'getState("coins") >= 5' } },
    );
    input.world.lorebook = { entries: [
      { id: 'excluded', title: 'Excluded lore', content: 'PRIVATE_LORE', load: {
        mode: 'on_mention', keywords: ['harbor'], exclude_keywords: ['manor'], when: 'getState("coins") >= 5',
      } },
      { id: 'false', title: 'False lore', content: 'PRIVATE_FALSE_LORE', load: { when: 'getState("coins") < 0' } },
      { id: 'bad', content: 'PRIVATE_BAD_LORE', load: { when: 'getState("missing") > 0' } },
    ] };
    const evaluateWhen = vi.fn(conditions.evaluateWhen);
    const result = selectNarrativeMaterials(input, { evaluateWhen });
    expect(evaluateWhen).toHaveBeenCalledTimes(3);
    expect(result.selection.characters).toMatchObject([
      { id: 'player', name: 'Robin', role: 'persona', matched: true, reason: 'matched' },
      { id: 'visitor', name: 'Visitor', role: 'character', matched: true, reason: 'matched',
        condition: { enabled: true, load: { mode: 'on_mention', when: 'getState("coins") >= 5' } },
        keywordMatch: { logic: 'all', matchedKeywords: ['harbor', 'manor'], excludedKeywords: [], result: true },
        whenMatch: { result: true } },
      { id: 'disabled', matched: false, reason: 'disabled' },
    ]);
    expect(result.selection.characters[2]).not.toHaveProperty('whenMatch');
    expect(result.selection.lore).toMatchObject([
      { id: 'excluded', name: 'Excluded lore', matched: false, reason: 'excluded',
        keywordMatch: { matchedKeywords: ['harbor'], excludedKeywords: ['manor'], result: false } },
      { id: 'false', name: 'False lore', matched: false, reason: 'when_false', whenMatch: { result: false } },
      { id: 'bad', name: 'bad', matched: false, reason: 'when_evaluation_failed', whenMatch: { result: null, error: 'evaluation_failed' } },
    ]);
    expect(result.selection.lore[0]).not.toHaveProperty('whenMatch');
    expect(JSON.stringify(result.selection)).not.toContain('PRIVATE_');
    expect(JSON.stringify(result.selection)).not.toContain(input.inputText);
  });

});
