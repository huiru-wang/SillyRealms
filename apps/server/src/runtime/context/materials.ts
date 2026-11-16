import { narrativeForActivation } from '@sillyrealms/roleplay';
import { ErrorCodes } from '../../common/error-codes.js';
import { evaluateLoad } from './activation.js';
import type { CompilationInput, PromptVariable, SystemVariables } from './contracts.js';

const encoded = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const prose = (value: string) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (value: string, category: 'systemBytes' | 'summaryBytes' | 'historyBytes' = 'systemBytes'): PromptVariable =>
  ({ type: 'text', value, category });

export function selectMaterials(input: CompilationInput) {
  const { world, views, playerId, history } = input;
  const scan = [...history.map(item => narrativeForActivation(item.text, item.role)), narrativeForActivation(input.input, 'user')];
  const diagnostics: Array<{ id: string; reason: string; path: string }> = [];
  const active = (source: { id: string; enabled?: boolean; load?: any }, path: string) => {
    const result = source.enabled === false ? { active: false, reason: 'disabled' } : evaluateLoad(source.load ?? {}, scan, views);
    if (['invalid_rule', 'when_evaluation_failed'].includes(result.reason)) diagnostics.push({ id: source.id, reason: result.reason, path });
    return result.active;
  };
  const player = world.characters.find(character => character.id === playerId && character.player_selectable);
  if (!player) throw new Error(ErrorCodes.INVALID_PLAYER_CHARACTER);
  const playerName = player.name.trim() || 'Default';
  // Existing world-card macros are resolved while building materials, independently of preset templates.
  const render = (value: string) => value.replaceAll('{{user}}', () => playerName);
  const playerActive = active(player, 'characters.' + player.id);
  const characters = world.characters.filter(character => character.id !== playerId && active(character, 'characters.' + character.id))
    .map((character, index) => ({ character, index }))
    .sort((a, b) => (a.character.order ?? 0) - (b.character.order ?? 0) || a.index - b.index);
  const lore = (world.lorebook?.entries ?? []).map((value, index) => ({ value, index }))
    .filter(({ value }) => active(value, 'lorebook.' + value.id))
    .sort((a, b) => (a.value.load?.order ?? 0) - (b.value.load?.order ?? 0) || a.index - b.index);
  const roots = Object.entries(world.state?.scopes.message ?? {})
    .filter(([name, definition]) => active({ id: name, load: definition.load }, 'state.message.' + name)).map(([name]) => name);
  const values = roots.map(name => '- ' + prose(name) + '：' + encoded(views.message[name])).join('\n');
  const rules = roots.map(name => {
    const definition = world.state!.scopes.message![name]!;
    return '- ' + prose(name) + '：' + encoded({
      description: render(definition.description ?? ''), type: definition.type,
      ...(definition.min !== undefined ? { min: definition.min } : {}),
      ...(definition.max !== undefined ? { max: definition.max } : {}),
    });
  }).join('\n');

  const variables: SystemVariables = {
    user: text(playerName),
    'persona.prompt': text(playerActive ? prose(render(player.prompt ?? '')) : ''),
    'characters.prompts': text(characters.map(({ character }) => prose(render(character.prompt ?? ''))).filter(Boolean).join('\n\n')),
    'world.lore': text(lore.map(({ value }) => prose(render(value.content))).join('\n\n')),
    'history.summary': text(prose(history.find(item => item.id === 'summary')?.text ?? ''), 'summaryBytes'),
    'history.messages': { type: 'messages', value: history.filter(item => item.id !== 'summary') },
    'input.text': text(input.input, 'historyBytes'),
    'state.currentValues': text(values),
    'state.updateRules': text(rules),
  };
  return { variables, roots, diagnostics };
}
