import { parseWhen } from '@sillyrealms/sdk/when-expression';

type SourcePosition = { line: number; column: number };
type TextNode = { type: 'text'; value: string };
type Branch = { expression: string | null; position: SourcePosition; nodes: AuthorNode[] };
type ConditionalNode = { type: 'conditional'; branches: Branch[] };
type AuthorNode = TextNode | ConditionalNode;

export type AuthorTemplate = { readonly nodes: readonly AuthorNode[] };
export type AuthorTemplateContext = {
  evaluateCondition: (expression: string) => boolean;
  renderText: (text: string) => string;
};

export class AuthorTemplateError extends Error {
  readonly kind: 'syntax' | 'evaluation';
  readonly line: number;
  readonly column: number;

  constructor(kind: 'syntax' | 'evaluation', position: SourcePosition, message: string) {
    super(message + '（第 ' + position.line + ' 行，第 ' + position.column + ' 列）');
    this.name = 'AuthorTemplateError';
    this.kind = kind;
    this.line = position.line;
    this.column = position.column;
  }
}

const maxDepth = 32;
const maxConditions = 256;

function sourcePosition(source: string, offset: number): SourcePosition {
  const lines = source.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

/** A delimiter inside a quoted condition value is part of the value, not the template. */
function directiveEnd(source: string, start: number): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = start + 2; index < source.length; index++) {
    const character = source[index]!;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
    } else if (character === "'" || character === '"') quote = character;
    else if (source.startsWith('%}', index)) return index;
  }
  throw new AuthorTemplateError('syntax', sourcePosition(source, start), '作者模板指令缺少结束标记 %}');
}

/** Parse only the original author source. State and player values are never template source. */
export function parseAuthorTemplate(source: string): AuthorTemplate {
  const nodes: AuthorNode[] = [];
  type Frame = { node: ConditionalNode; parent: AuthorNode[]; position: SourcePosition; hasElse: boolean };
  const stack: Frame[] = [];
  let current = nodes;
  let literal = '';
  let conditionCount = 0;
  const flush = () => {
    if (literal) current.push({ type: 'text', value: literal });
    literal = '';
  };
  function fail(position: SourcePosition, message: string): never {
    throw new AuthorTemplateError('syntax', position, message);
  }
  const condition = (expression: string, position: SourcePosition): Branch => {
    if (!expression) fail(position, '作者模板条件不能为空');
    if (++conditionCount > maxConditions) fail(position, '作者模板最多允许 256 个条件');
    try { parseWhen(expression); }
    catch { fail(position, '作者模板条件表达式无效'); }
    return { expression, position, nodes: [] };
  };

  for (let index = 0; index < source.length;) {
    if (source[index] === '\\' && source.startsWith('{%', index + 1)) {
      literal += '{%';
      index += 3;
      continue;
    }
    if (!source.startsWith('{%', index)) {
      literal += source[index++]!;
      continue;
    }
    flush();
    const position = sourcePosition(source, index);
    const end = directiveEnd(source, index);
    const directive = source.slice(index + 2, end).trim();
    const match = /^(if|elif|else|endif)(?:\s+([\s\S]*))?$/.exec(directive);
    if (!match) fail(position, '未知的作者模板指令');
    const keyword = match[1]!;
    const expression = (match[2] ?? '').trim();
    index = end + 2;

    if (keyword === 'if') {
      if (stack.length >= maxDepth) fail(position, '作者模板最多允许 32 层条件嵌套');
      const branch = condition(expression, position);
      const node: ConditionalNode = { type: 'conditional', branches: [branch] };
      current.push(node);
      stack.push({ node, parent: current, position, hasElse: false });
      current = branch.nodes;
      continue;
    }

    const frame = stack.at(-1);
    if (!frame) fail(position, '作者模板指令缺少对应的 if');
    if (keyword === 'elif') {
      if (frame.hasElse) fail(position, '作者模板 else 之后不能再出现 elif');
      const branch = condition(expression, position);
      frame.node.branches.push(branch);
      current = branch.nodes;
    } else if (keyword === 'else') {
      if (expression) fail(position, '作者模板 else 不能附带条件');
      if (frame.hasElse) fail(position, '作者模板同一条件块不能重复 else');
      frame.hasElse = true;
      const branch: Branch = { expression: null, position, nodes: [] };
      frame.node.branches.push(branch);
      current = branch.nodes;
    } else {
      if (expression) fail(position, '作者模板 endif 不能附带条件');
      stack.pop();
      current = frame.parent;
    }
  }

  flush();
  const unclosed = stack.at(-1);
  if (unclosed) fail(unclosed.position, '作者模板条件块缺少 endif');
  return { nodes };
}

/** Render only selected source leaves; never parse callback output or assembled text again. */
export function renderAuthorTemplate(template: AuthorTemplate, context: AuthorTemplateContext): string {
  const render = (nodes: readonly AuthorNode[]): string => {
    const output: string[] = [];
    for (const node of nodes) {
      if (node.type === 'text') {
        output.push(context.renderText(node.value));
        continue;
      }
      for (const branch of node.branches) {
        let matched = true;
        if (branch.expression !== null) {
          try {
            const result = context.evaluateCondition(branch.expression);
            if (typeof result !== 'boolean') throw new Error('Expected a boolean condition');
            matched = result;
          } catch {
            throw new AuthorTemplateError('evaluation', branch.position, '作者模板条件求值失败');
          }
        }
        if (matched) {
          output.push(render(branch.nodes));
          break;
        }
      }
    }
    return output.join('');
  };
  return render(template.nodes);
}
