import type { StateScope } from '@sillyrealms/sdk/state-validation';
import { AppError } from '../errors.js';
import { statePathParts } from './state-path.js';

export type StateReference = { type: 'state'; scope: StateScope; parts: string[] };
type Segment<Name extends string> = { type: 'text'; value: string } | { type: 'variable'; name: Name } | StateReference;

export function parsePromptTemplate<Name extends string>(
  prompt: string, names: readonly Name[], mode: 'preset' | 'author' = 'preset',
): Segment<Name>[] {
  const segments: Segment<Name>[] = [];
  let literal = '';
  const flush = () => {
    if (literal) segments.push({ type: 'text', value: literal });
    literal = '';
  };
  for (let index = 0; index < prompt.length;) {
    if (mode === 'preset' && prompt[index] === '\\') {
      if (prompt[index + 1] === '\\') { literal += '\\'; index += 2; continue; }
      if (prompt.startsWith('{{', index + 1)) { literal += '{{'; index += 3; continue; }
    }
    if (!prompt.startsWith('{{', index)) { literal += prompt[index++]!; continue; }
    const start = index;
    index += 2;
    while (index < prompt.length && !prompt.startsWith('}}', index) && !prompt.startsWith('{{', index)) index++;
    if (!prompt.startsWith('}}', index)) {
      if (mode === 'preset') throw new AppError('INVALID_NARRATIVE_TEMPLATE', '系统变量缺少结束标记 }}');
      literal += prompt.slice(start, index);
      continue;
    }
    const rawName = prompt.slice(start + 2, index);
    const name = rawName.trim();
    index += 2;
    const builtin = names.find(candidate => candidate === (mode === 'preset' ? name : rawName));
    if (builtin !== undefined) {
      flush();
      segments.push({ type: 'variable', name: builtin });
    } else if (name.startsWith('state.') && !['state.global', 'state.session', 'state.message'].includes(name)) {
      const separator = name.indexOf('.', 6);
      const scope = separator < 0 ? '' : name.slice(6, separator);
      const parts = separator < 0 ? null : statePathParts(name.slice(separator + 1));
      if (parts && (scope === 'global' || scope === 'session' || scope === 'message')) {
        flush();
        segments.push({ type: 'state', scope, parts });
      } else if (mode === 'preset') throw new AppError('INVALID_NARRATIVE_TEMPLATE', '状态变量路径无效：' + name);
    } else if (mode === 'author') literal += prompt.slice(start, index);
    else throw new AppError('INVALID_NARRATIVE_TEMPLATE', '未知系统变量：' + (name || '空名称'));
  }
  flush();
  return segments;
}
