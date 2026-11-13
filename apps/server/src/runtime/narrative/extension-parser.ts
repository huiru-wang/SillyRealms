import { ErrorCodes, type ErrorCode } from '../../common/error-codes.js';
import { MAX_TAIL_BYTES } from './extension-stream-splitter.js';

export type ParsedBlock = { value?: unknown; error?: ErrorCode };
export type ParsedExtensions = { state_update?: ParsedBlock; action_suggestions?: ParsedBlock; error?: ErrorCode };

/** JSON.parse cannot detect duplicate object keys. This parser checks grammar, keys and depth first. */
export function parseStrictJson(text: string): unknown {
  let offset = 0;
  const whitespace = () => { while (/[ \t\r\n]/u.test(text[offset] ?? '') && offset < text.length) offset++; };
  const fail = (): never => { throw new Error('INVALID_JSON'); };
  const string = (): string => {
    const start = offset;
    if (text[offset++] !== '"') return fail();
    let escaped = false;
    while (offset < text.length) {
      const char = text[offset++]!;
      if (!escaped && char === '"') return JSON.parse(text.slice(start, offset)) as string;
      if (!escaped && char.charCodeAt(0) < 32) return fail();
      if (!escaped && char === '\\') escaped = true; else escaped = false;
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
        whitespace(); const key = string();
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
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const)
      if (text.startsWith(literal, offset)) { offset += literal.length; return result; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(offset));
    if (number) { offset += number[0].length; const parsed = Number(number[0]); if (Number.isFinite(parsed)) return parsed; }
    return fail();
  };
  const result = value(0); whitespace();
  if (offset !== text.length) return fail();
  return result;
}

/** Child payloads may fail independently only when their lexical frames are unambiguous. */
export function parseExtensions(tail?: string): ParsedExtensions {
  if (tail === undefined) return {};
  if (Buffer.byteLength(tail, 'utf8') > MAX_TAIL_BYTES) return { error: ErrorCodes.EXTENSION_TAIL_TOO_LARGE };
  const result: ParsedExtensions = {};
  const ids = ['state_update', 'action_suggestions'] as const;
  let offset = 0, order = -1;
  const skip = () => { while (offset < tail.length && /\s/u.test(tail[offset]!)) offset++; };
  const fail = (): ParsedExtensions => ({ error: ErrorCodes.EXTENSION_PROTOCOL_INVALID });
  skip();
  if (!tail.startsWith('<sr_extensions>', offset)) return fail();
  offset += '<sr_extensions>'.length;
  while (offset < tail.length) {
    skip();
    if (tail.startsWith('</sr_extensions>', offset)) {
      offset += '</sr_extensions>'.length; skip();
      return offset === tail.length ? result : fail();
    }
    const id = ids.find(name => tail.startsWith('<' + name + '>', offset));
    if (!id) return fail();
    const nextOrder = ids.indexOf(id);
    if (nextOrder < order) return fail();
    order = nextOrder;
    offset += id.length + 2;
    const start = offset, close = '</' + id + '>';
    let quoted = false, escaped = false, found = false;
    const stack: string[] = [];
    for (; offset < tail.length; offset++) {
      const char = tail[offset]!;
      if (quoted) {
        if (!escaped && char === '"') quoted = false;
        if (!escaped && char === '\\') escaped = true; else escaped = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '[' || char === '{') { stack.push(char); continue; }
      if (char === ']' || char === '}') {
        if (stack.pop() !== (char === ']' ? '[' : '{')) return fail();
        continue;
      }
      if (char === '<') {
        if (!stack.length && tail.startsWith(close, offset)) { found = true; break; }
        return fail();
      }
    }
    if (!found || quoted || stack.length) return fail();
    const error = id === 'state_update' ? ErrorCodes.STATE_UPDATE_INVALID : ErrorCodes.ACTION_SUGGESTIONS_INVALID;
    if (result[id]) result[id] = { error };
    else {
      try { result[id] = { value: parseStrictJson(tail.slice(start, offset)) }; }
      catch { result[id] = { error }; }
    }
    offset += close.length;
  }
  return fail();
}
