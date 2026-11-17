/** Named Context values available to preset templates; lookup never evaluates object paths. */
export const systemVariableNames = [
  'user', 'persona.prompt', 'characters.prompts', 'world.lore',
  'history.summary', 'history.messages', 'input.text', 'state.entries',
] as const;

export type SystemVariableName = typeof systemVariableNames[number];
export type PromptSegment =
  | { type: 'text'; value: string }
  | { type: 'variable'; name: SystemVariableName };

const variables = new Set<string>(systemVariableNames);

/** Scan only the template. Resolved values are data and are never parsed again. */
export function parsePromptTemplate(prompt: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  let literal = '';
  const flush = () => {
    if (literal) segments.push({ type: 'text', value: literal });
    literal = '';
  };
  for (let i = 0; i < prompt.length;) {
    if (prompt[i] === '\\') {
      if (prompt[i + 1] === '\\') {
        literal += '\\';
        i += 2;
        continue;
      }
      if (prompt.startsWith('{{', i + 1)) {
        literal += '{{';
        i += 3;
        continue;
      }
    }
    if (!prompt.startsWith('{{', i)) {
      literal += prompt[i];
      i++;
      continue;
    }
    const end = prompt.indexOf('}}', i + 2);
    if (end === -1) throw new Error('系统变量缺少结束标记 }}（位置 ' + (i + 1) + '）');
    const name = prompt.slice(i + 2, end).trim();
    if (!variables.has(name)) throw new Error('未知系统变量：' + (name || '空名称'));
    flush();
    segments.push({ type: 'variable', name: name as SystemVariableName });
    i = end + 2;
  }
  flush();
  return segments;
}
