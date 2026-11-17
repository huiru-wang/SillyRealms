import { ErrorCodes, type ErrorCode } from '../../common/error-codes.js';
import { MAX_TAIL_BYTES } from './stream-splitter.js';

export type ParsedBlock = { value?: unknown; error?: ErrorCode };
export type ParsedExtensions = { state_update?: ParsedBlock; action_suggestions?: ParsedBlock; error?: ErrorCode };

import { parseStrictJson } from './strict-json.js';

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
  while (offset < tail.length) {
    skip();
    if(offset===tail.length)return result;
    const id = ids.find(name => tail.startsWith('<' + name + '>', offset));
    if (!id) return fail();
    const nextOrder = ids.indexOf(id);
    if (nextOrder <= order) return fail();
    order = nextOrder;
    offset += id.length + 2;
    const start = offset, close = '</' + id + '>';
    let quoted = false, escaped = false, found = false;
    for (; offset < tail.length; offset++) {
      const char = tail[offset]!;
      if (quoted) {
        if (!escaped && char === '"') quoted = false;
        if (!escaped && char === '\\') escaped = true; else escaped = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '<') {
        // JSON structure/depth belongs to this plugin; it must not invalidate its sibling.
        if (tail.startsWith(close, offset)) { found = true; break; }
        return fail();
      }
    }
    if (!found || quoted) return fail();
    const error = id === 'state_update' ? ErrorCodes.STATE_UPDATE_INVALID : ErrorCodes.ACTION_SUGGESTIONS_INVALID;
    try { result[id] = { value: parseStrictJson(tail.slice(start, offset)) }; }
    catch { result[id] = { error }; }
    offset += close.length;
  }
  return result;
}
