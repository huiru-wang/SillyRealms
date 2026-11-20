import { AppError } from '../../../errors.js';

export type PromptSegment<Name extends string> = { type: 'text'; value: string } | { type: 'variable'; name: Name };

/** Scan the template exactly once; substituted author/user values remain literal data. */
export function parsePromptTemplate<Name extends string>(prompt: string, names: readonly Name[]): PromptSegment<Name>[] {
  const variables = new Set<string>(names);
  const segments: PromptSegment<Name>[] = [];
  let literal = '';
  const flush = () => {
    if (literal) segments.push({ type: 'text', value: literal });
    literal = '';
  };
  for (let index = 0; index < prompt.length;) {
    if (prompt[index] === '\\') {
      if (prompt[index + 1] === '\\') { literal += '\\'; index += 2; continue; }
      if (prompt.startsWith('{{', index + 1)) { literal += '{{'; index += 3; continue; }
    }
    if (!prompt.startsWith('{{', index)) { literal += prompt[index]!; index++; continue; }
    const end = prompt.indexOf('}}', index + 2);
    if (end === -1) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
    const name = prompt.slice(index + 2, end).trim();
    if (!variables.has(name)) throw new AppError('INVALID_NARRATIVE_TEMPLATE');
    flush();
    segments.push({ type: 'variable', name: name as Name });
    index = end + 2;
  }
  flush();
  return segments;
}
