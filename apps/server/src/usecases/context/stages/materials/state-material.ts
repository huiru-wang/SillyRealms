import type { StateDefinition } from '@sillyrealms/sdk/state-validation';
import type { StateViews } from '../../../../modules/state/service.js';

export const escapeMaterialText = (value: string) => value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const encodeMaterialJson = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
  .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
const materialText = (value: string, continuation: string) => escapeMaterialText(value).replace(/\r\n?|\n|\u2028|\u2029/g, '\n' + continuation);

function compareRulePaths(left: string, right: string): number {
  const a = left.match(/[^.[\]]+|\[\]/g) ?? [], b = right.match(/[^.[\]]+|\[\]/g) ?? [];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return a.length - b.length;
}

export function renderStateFacts(scope: keyof StateViews, definitions: Record<string, StateDefinition>,
  roots: readonly string[], snapshot: StateViews[keyof StateViews], playerName: string): string {
  return roots.map(name => {
    const field = definitions[name]!;
    return [
      '- ' + materialText(name, '  ') + ':',
      '    - value: ' + (Object.hasOwn(snapshot, name) ? encodeMaterialJson(snapshot[name]) : '未设置（当前快照无此状态）'),
      ...(scope === 'message' && field.type === 'json' ? ['    - type: json'] : []),
      '    - description: ' + materialText(field.description.replaceAll('{{user}}', () => playerName), '        '),
    ].join('\n');
  }).join('\n');
}

export function renderMessageRules(definitions: Record<string, StateDefinition>, roots: readonly string[], playerName: string): string {
  return roots.map(name => {
    const lines = ['- ' + materialText(name, '  ') + ':'];
    const rules = Object.entries(definitions[name]!.rules ?? {}).sort(([a], [b]) => compareRulePaths(a, b));
    if (rules.length) lines.push('    - rules:');
    for (const [path, rule] of rules) {
      lines.push('        - ' + materialText(path, '            ') +
        (path.includes('[]') ? '（元素规则，非直接更新路径）' : '') + ': ' +
        materialText(rule.replaceAll('{{user}}', () => playerName), '            '));
    }
    return lines.join('\n');
  }).join('\n');
}
