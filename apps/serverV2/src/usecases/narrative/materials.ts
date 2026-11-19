import { narrativeForActivation } from '@sillyrealms/roleplay';
import { validateStateSchema } from '@sillyrealms/sdk/state-validation';
import { AppError } from '../../errors.js';
import type { StateService, StateViews } from '../../modules/state/service.js';
import type { World, WorldCard } from '../../modules/worlds/service.js';

export type NarrativeHistoryMessage = { id: string; role: 'user' | 'assistant'; text: string; timestamp: number };
export type MaterialSources = {
  world: World;
  views: StateViews;
  playerId: string;
  inputText: string;
  history: readonly NarrativeHistoryMessage[];
};
export const systemVariableNames = [
  'user', 'persona.prompt', 'characters.prompts', 'world.lore',
  'history.summary', 'history.messages', 'input.text', 'state.entries',
] as const;
export type SystemVariableName = typeof systemVariableNames[number];
export type PromptVariable = { type: 'text'; value: string } | { type: 'messages'; value: readonly NarrativeHistoryMessage[] };
export type NarrativeMaterials = {
  variables: Record<SystemVariableName, PromptVariable>;
  activeRoots: string[];
  diagnostics: { id: string; reason: string; path: string }[];
};
type Character = WorldCard['data']['characters'][number] & { enabled?: boolean };
type LoreEntry = NonNullable<WorldCard['data']['lorebook']>['entries'][number];
type LoadRule = NonNullable<Character['load']>;
type Conditions = Pick<StateService, 'evaluateWhen'>;

const prose = (value: string) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const text = (value: string): PromptVariable => ({ type: 'text', value });
const encoded = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
  .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const materialText = (value: string, continuation: string) => prose(value).replace(/\r\n?|\n|\u2028|\u2029/g, '\n' + continuation);

/** Keep the established case-sensitive, per-message keyword semantics. */
export function evaluateLoad(rule: LoadRule, scan: readonly string[], views: StateViews, conditions: Conditions) {
  if (rule.mode === 'never') return { active: false, reason: 'never' };
  if (rule.mode !== undefined && !['always', 'on_mention'].includes(rule.mode)) return { active: false, reason: 'invalid_rule' };
  if (rule.mode === 'on_mention') {
    if (!rule.keywords?.length || rule.keywords.some(keyword => !keyword)
      || (rule.keyword_logic !== undefined && !['any', 'all'].includes(rule.keyword_logic))) {
      return { active: false, reason: 'invalid_rule' };
    }
    const matched = (keyword: string) => scan.some(message => message.includes(keyword));
    if (rule.exclude_keywords?.some(matched)) return { active: false, reason: 'excluded' };
    const included = rule.keyword_logic === 'all' ? rule.keywords.every(matched) : rule.keywords.some(matched);
    if (!included) return { active: false, reason: 'keyword_unmatched' };
  }
  if (rule.when !== undefined) {
    try {
      if (!conditions.evaluateWhen(rule.when, views)) return { active: false, reason: 'when_false' };
    } catch { return { active: false, reason: 'when_evaluation_failed' }; }
  }
  return { active: true, reason: 'matched' };
}

function compareRulePaths(left: string, right: string): number {
  const a = left.match(/[^.[\]]+|\[\]/g) ?? [], b = right.match(/[^.[\]]+|\[\]/g) ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** Select material from captured author data; this function never reads or writes storage. */
export function selectNarrativeMaterials(input: MaterialSources, conditions: Conditions): NarrativeMaterials {
  const { world, views, playerId, history, inputText } = input;
  const scan = [...history.map(item => narrativeForActivation(item.text, item.role)), narrativeForActivation(inputText, 'user')];
  const diagnostics: NarrativeMaterials['diagnostics'] = [];
  const active = (source: { id: string; enabled?: boolean; load?: LoadRule }, path: string) => {
    const result = source.enabled === false ? { active: false, reason: 'disabled' }
      : evaluateLoad(source.load ?? {}, scan, views, conditions);
    if (result.reason === 'invalid_rule' || result.reason === 'when_evaluation_failed') {
      diagnostics.push({ id: source.id, reason: result.reason, path });
    }
    return result.active;
  };
  // These values retain the validated author protocol inside the World domain object.
  const characters = world.characters as unknown as Character[];
  const player = characters.find(character => character.id === playerId && character.player_selectable);
  if (!player) throw new AppError('INVALID_SESSION_CHARACTER');
  const playerName = player.name.trim() || 'Default';
  const render = (value: string) => value.replaceAll('{{user}}', () => playerName);
  const playerActive = active(player, 'characters.' + player.id);
  const selected = characters.map((character, index) => ({ character, index }))
    .filter(({ character }) => character.id !== playerId && active(character, 'characters.' + character.id))
    .sort((a, b) => (a.character.order ?? 0) - (b.character.order ?? 0) || a.index - b.index);
  const lorebook = world.lorebook as unknown as { entries: LoreEntry[] } | null;
  const lore = (lorebook?.entries ?? []).map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => active(entry, 'lorebook.' + entry.id))
    .sort((a, b) => (a.entry.load?.order ?? 0) - (b.entry.load?.order ?? 0) || a.index - b.index);
  const definition = world.stateDefinition;
  if (definition !== null) {
    try { validateStateSchema(definition); }
    catch { throw new AppError('INVALID_NARRATIVE_STATE'); }
  }
  const definitions = definition?.scopes.message ?? {};
  const activeRoots = Object.entries(definitions)
    .filter(([name, value]) => active({ id: name, load: value.load }, 'state.message.' + name)).map(([name]) => name);
  const entries = activeRoots.map(name => {
    const value = definitions[name]!;
    const rules = Object.entries(value.rules).sort(([left], [right]) => compareRulePaths(left, right));
    return [
      '- ' + materialText(name, '  ') + ':',
      '    - value: ' + (Object.hasOwn(views.message, name) ? encoded(views.message[name]) : '未设置（当前快照无此状态）'),
      '    - type: ' + value.type,
      ...(value.min === undefined ? [] : ['    - min: ' + encoded(value.min)]),
      ...(value.max === undefined ? [] : ['    - max: ' + encoded(value.max)]),
      '    - description: ' + materialText(render(value.description), '        '),
      '    - rules:',
      ...rules.map(([path, rule]) => '        - ' + materialText(path, '            ') +
        (path.includes('[]') ? '（元素规则，非直接更新路径）' : '') + ': ' + materialText(render(rule), '            ')),
    ].join('\n');
  }).join('\n');
  return {
    variables: {
      user: text(playerName),
      'persona.prompt': text(playerActive ? prose(render(player.prompt ?? '')) : ''),
      'characters.prompts': text(selected.map(({ character }) => prose(render(character.prompt ?? ''))).filter(Boolean).join('\n\n')),
      'world.lore': text(lore.map(({ entry }) => prose(render(entry.content))).join('\n\n')),
      'history.summary': text(''),
      'history.messages': { type: 'messages', value: history },
      'input.text': text(inputText),
      'state.entries': text(entries),
    },
    activeRoots, diagnostics,
  };
}
