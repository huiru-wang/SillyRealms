import { describe, expect, it } from 'vitest';
import { StateService } from '../../modules/state/service.js';
import { selectNarrativeMaterials, type MaterialSources } from './materials.js';

const conditions = { evaluateWhen: StateService.prototype.evaluateWhen };
function sources(): MaterialSources {
  return {
    world: {
      id: 'world', revision: 1, specVersion: '0.1', name: 'World', description: null, cover: null,
      characters: [{ id: 'player', name: 'Robin', player_selectable: true, prompt: 'You are {{user}}.' }],
      openings: [], lorebook: null, stateDefinition: null, messageRender: null, components: null,
      stageComponent: null, extensions: null, defaultPresetId: null, defaultApiModelConfigId: null,
      state: {}, tags: [], createdAt: 0, updatedAt: 0,
    },
    playerId: 'player', inputText: 'Enter the harbor',
    history: [{ id: 'a', role: 'assistant', text: 'The manor is nearby.', timestamp: 1 }],
    views: { global: { day: 2 }, session: { unlocked: true }, message: { coins: 5 } },
  };
}
function variable(input: MaterialSources, name: 'persona.prompt' | 'characters.prompts' | 'world.lore' | 'state.entries') {
  const value = selectNarrativeMaterials(input, conditions).variables[name];
  if (value.type !== 'text') throw new Error('Expected text variable');
  return value.value;
}

describe('narrative material selection', () => {
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
    const text = variable(input, 'state.entries');
    expect(text).toContain('value: 5');
    expect(text).toContain('Coins for Robin');
    expect(text).toContain('未设置（当前快照无此状态）');
    expect(text).not.toContain('Do not initialize this');
    expect(text).not.toContain('<state_update>');
    expect(input.views.message).toEqual({ coins: 5 });
  });
});
