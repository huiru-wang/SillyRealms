/** Validate JSON grammar, decoded duplicate keys and per-value depth without shared output quotas. */
export function parseStrictJson(text: string): unknown {
  let offset = 0;
  const whitespace = () => {
    while (offset < text.length && /[ \t\r\n]/u.test(text[offset]!)) offset++;
  };
  const fail = (): never => { throw new Error('INVALID_JSON'); };
  const string = (): string => {
    const start = offset;
    if (text[offset++] !== '"') return fail();
    let escaped = false;
    while (offset < text.length) {
      const char = text[offset++]!;
      if (!escaped && char === '"') return JSON.parse(text.slice(start, offset)) as string;
      if (!escaped && char.charCodeAt(0) < 32) return fail();
      if (!escaped && char === '\\') escaped = true;
      else escaped = false;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) return fail();
    whitespace();
    if (text[offset] === '"') return string();
    if (text[offset] === '{') {
      offset++; whitespace();
      const result: Record<string, unknown> = Object.create(null);
      const keys = new Set<string>();
      if (text[offset] === '}') { offset++; return result; }
      while (offset < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) return fail();
        keys.add(key); whitespace();
        if (text[offset++] !== ':') return fail();
        result[key] = value(depth + 1); whitespace();
        const separator = text[offset++];
        if (separator === '}') return result;
        if (separator !== ',') return fail();
      }
      return fail();
    }
    if (text[offset] === '[') {
      offset++; whitespace();
      const result: unknown[] = [];
      if (text[offset] === ']') { offset++; return result; }
      while (offset < text.length) {
        result.push(value(depth + 1)); whitespace();
        const separator = text[offset++];
        if (separator === ']') return result;
        if (separator !== ',') return fail();
      }
      return fail();
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (number) {
      offset += number[0].length;
      const parsed = Number(number[0]);
      if (Number.isFinite(parsed)) return parsed;
    }
    return fail();
  };
  const result = value(0);
  whitespace();
  if (offset !== text.length) return fail();
  return result;
}

export type JsonlResult = { ok: true; value: unknown } | { ok: false; status: 'invalid_json' };

/** Every nonempty physical line is independent; object/value rules belong to StateService. */
export function parseJsonl(blocks: readonly string[]): JsonlResult[] {
  const results: JsonlResult[] = [];
  for (const block of blocks) {
    for (const line of block.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try { results.push({ ok: true, value: parseStrictJson(line) }); }
      catch { results.push({ ok: false, status: 'invalid_json' }); }
    }
  }
  return results;
}
