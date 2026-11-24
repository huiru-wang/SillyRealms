import { languageNames, type AppLocale } from '@sillyrealms/sdk/locale';
import { systemVariableNames } from '../../../../modules/presets/service.js';
import { narrativeForActivation } from '@sillyrealms/roleplay';
import { validateStateSchema } from '@sillyrealms/sdk/state-validation';
import { AppError } from '../../../../errors.js';
import { parsePromptTemplate } from '../../../../lib/prompt-template.js';
import { readStateVariable, type VisibleRoots } from '../../lib/state-variable.js';
import type { StateService, StateViews } from '../../../../modules/state/service.js';
import type { CharacterSpriteCatalogItem, World, WorldCard } from '../../../../modules/worlds/service.js';
import type { NarrativeHistoryMessage } from '../history/index.js';
import type { ContextMaterialDiagnostic } from '../../diagnostics.js';

export type MaterialSources = {
  locale: AppLocale;
  world: World;
  views: StateViews;
  playerId: string;
  inputText: string;
  history: readonly NarrativeHistoryMessage[];
  summary?: string;
  /** The prompt-visible catalog; callers pass an empty array when its node is disabled. */
  characterSpriteCatalog?: readonly CharacterSpriteCatalogItem[];
};
export type SystemVariableName = typeof systemVariableNames[number];
export type PromptVariable = { type: 'text'; value: string } | { type: 'messages'; value: readonly NarrativeHistoryMessage[] };
export type NarrativeMaterials = {
  variables: Record<SystemVariableName, PromptVariable>;
  activeRoots: string[];
  visibleRoots: VisibleRoots;
  diagnostics: { id: string; reason: string; path: string }[];
  selection: { characters: ContextMaterialDiagnostic[]; lore: ContextMaterialDiagnostic[] };
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

type LoadEvaluation = Pick<ContextMaterialDiagnostic, 'reason' | 'keywordMatch' | 'whenMatch'> & { active: boolean };

/** Keep the established case-sensitive, per-message keyword semantics and reuse these checks in diagnostics. */
export function evaluateLoad(rule: LoadRule, scan: readonly string[], views: StateViews, conditions: Conditions): LoadEvaluation {
  if (rule.mode === 'never') return { active: false, reason: 'never' };
  if (rule.mode !== undefined && !['always', 'on_mention'].includes(rule.mode)) return { active: false, reason: 'invalid_rule' };
  const checks: Pick<LoadEvaluation, 'keywordMatch' | 'whenMatch'> = {};
  if (rule.mode === 'on_mention') {
    if (!rule.keywords?.length || rule.keywords.some(keyword => !keyword)
      || (rule.keyword_logic !== undefined && !['any', 'all'].includes(rule.keyword_logic))) {
      return { active: false, reason: 'invalid_rule' };
    }
    const matches = new Map<string, boolean>();
    const matched = (keyword: string) => {
      if (!matches.has(keyword)) matches.set(keyword, scan.some(message => message.includes(keyword)));
      return matches.get(keyword)!;
    };
    const matchedKeywords = rule.keywords.filter(matched);
    const excludedKeywords = rule.exclude_keywords?.filter(matched) ?? [];
    const logic = rule.keyword_logic ?? 'any';
    const included = logic === 'all' ? matchedKeywords.length === rule.keywords.length : matchedKeywords.length > 0;
    checks.keywordMatch = { logic, matchedKeywords, excludedKeywords, result: !excludedKeywords.length && included };
    if (excludedKeywords.length) return { active: false, reason: 'excluded', ...checks };
    if (!included) return { active: false, reason: 'keyword_unmatched', ...checks };
  }
  if (rule.when !== undefined) {
    try {
      const result = conditions.evaluateWhen(rule.when, views);
      checks.whenMatch = { result };
      if (!result) return { active: false, reason: 'when_false', ...checks };
    } catch { return { active: false, reason: 'when_evaluation_failed', ...checks, whenMatch: { result: null, error: 'evaluation_failed' } }; }
  }
  return { active: true, reason: 'matched', ...checks };
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
  const scan = [input.summary ?? '', ...history.map(item => narrativeForActivation(item.text, item.role)), narrativeForActivation(inputText, 'user')];
  const diagnostics: NarrativeMaterials['diagnostics'] = [];
  const selection: NarrativeMaterials['selection'] = { characters: [], lore: [] };
  const active = (source: { id: string; enabled?: boolean; load?: LoadRule }, path: string,
    record?: { target: ContextMaterialDiagnostic[]; name: string; role?: 'persona' | 'character' }) => {
    const result: LoadEvaluation = source.enabled === false ? { active: false, reason: 'disabled' }
      : evaluateLoad(source.load ?? {}, scan, views, conditions);
    if (result.reason === 'invalid_rule' || result.reason === 'when_evaluation_failed') {
      diagnostics.push({ id: source.id, reason: result.reason, path });
    }
    if (record) selectionRecord(record, source, result);
    return result.active;
  };
  const selectionRecord = (record: { target: ContextMaterialDiagnostic[]; name: string; role?: 'persona' | 'character' },
    source: { id: string; enabled?: boolean; load?: LoadRule }, result: LoadEvaluation) => {
    const { active: matched, ...checks } = result;
    record.target.push({ id: source.id, name: record.name, ...(record.role ? { role: record.role } : {}),
      condition: { enabled: source.enabled !== false, load: structuredClone(source.load ?? {}) }, matched, ...checks });
  };
  // These values retain the validated author protocol inside the World domain object.
  const characters = world.characters as unknown as Character[];
  const player = characters.find(character => character.id === playerId && character.player_selectable);
  if (!player) throw new AppError('INVALID_SESSION_CHARACTER');
  const playerName = player.name.trim() || 'Default';
  const render = (value: string) => value.replaceAll('{{user}}', () => playerName);
  const playerActive = active(player, 'characters.' + player.id, { target: selection.characters, name: player.name, role: 'persona' });
  const selected = characters.map((character, index) => ({ character, index }))
    .filter(({ character }) => character.id !== playerId && active(character, 'characters.' + character.id, { target: selection.characters, name: character.name, role: 'character' }))
    .sort((a, b) => (a.character.order ?? 0) - (b.character.order ?? 0) || a.index - b.index);
  const lorebook = world.lorebook as unknown as { entries: LoreEntry[] } | null;
  const lore = (lorebook?.entries ?? []).map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => active(entry, 'lorebook.' + entry.id, { target: selection.lore, name: entry.title?.trim() || entry.id }))
    .sort((a, b) => (a.entry.load?.order ?? 0) - (b.entry.load?.order ?? 0) || a.index - b.index);
  const definition = world.stateDefinition;
  if (definition !== null) {
    try { validateStateSchema(definition, 'stored'); }
    catch { throw new AppError('INVALID_NARRATIVE_STATE'); }
  }
  const scopes = definition?.scopes;
  function stateMaterial(scope: keyof StateViews) {
    const definitions = scopes?.[scope] ?? {};
    const roots = Object.keys(definitions).filter(name =>
      active({ id: name, load: definitions[name]!.load }, 'state.' + scope + '.' + name));
    const snapshot = views[scope];
    const entries = roots.map(name => {
      const field = definitions[name]!;
      const lines = [
        '- ' + materialText(name, '  ') + ':',
        '    - value: ' + (Object.hasOwn(snapshot, name) ? encoded(snapshot[name]) : '未设置（当前快照无此状态）'),
        '    - type: ' + field.type,
        ...(field.min === undefined ? [] : ['    - min: ' + encoded(field.min)]),
        ...(field.max === undefined ? [] : ['    - max: ' + encoded(field.max)]),
        '    - description: ' + materialText(render(field.description), '        '),
      ];
      if (scope === 'message' && field.rules) {
        const rules = Object.entries(field.rules).sort(([a], [b]) => compareRulePaths(a, b));
        if (rules.length) lines.push('    - rules:');
        for (const [path, rule] of rules) {
          lines.push('        - ' + materialText(path, '            ') +
            (path.includes('[]') ? '（元素规则，非直接更新路径）' : '') + ': ' + materialText(render(rule), '            '));
        }
      }
      return lines.join('\n');
    });
    return { roots, variable: text(entries.join('\n')) };
  }
  const message = stateMaterial('message');
  const session = stateMaterial('session');
  const global = stateMaterial('global');
  const visibleRoots = { message: new Set(message.roots), session: new Set(session.roots), global: new Set(global.roots) };
  const authorPrompt = (prompt: string) => prose(parsePromptTemplate(prompt, ['user'], 'author').map(segment => {
    if (segment.type === 'text') return segment.value;
    if (segment.type === 'variable') return playerName;
    return readStateVariable(segment, views, visibleRoots);
  }).join(''));
  return {
    variables: {
      'system.language': text(languageNames[input.locale]),
      user: text(playerName),
      'persona.prompt': text(playerActive ? authorPrompt(player.prompt ?? '') : ''),
      'characters.prompts': text(selected.map(({ character }) => authorPrompt(character.prompt ?? '')).filter(Boolean).join('\n\n')),
      'world.lore': text(lore.map(({ entry }) => authorPrompt(entry.content)).join('\n\n')),
      'history.summary': text(input.summary ?? ''),
      'history.messages': { type: 'messages', value: history },
      'input.text': text(inputText),
      'state.message': message.variable,
      'state.session': session.variable,
      'state.global': global.variable,
      'characterSprite.catalog': text(input.characterSpriteCatalog?.length
        ? encoded({ playerCharacterId: playerId, items: input.characterSpriteCatalog.map(({ characterId, characterName, spriteId, description }) =>
          ({ characterId, characterName, spriteId, description })) }) : ''),
    },
    activeRoots: message.roots, visibleRoots, diagnostics, selection,
  };
}
