import { describe, expect, it } from 'vitest';
import { parseJsonl, parseStrictJson } from './strict-json.js';

describe('strict postprocess JSON', () => {
  it('preserves valid JSON values, escaped strings and harmless prototype-key data', () => {
    expect(parseStrictJson('{"a":[1,-2.5e2,true,false,null,"\\\\","\\u003Cstate_update\\u003E"],"__proto__":{"x":1}}'))
      .toEqual({ a: [1, -250, true, false, null, '\\', '<state_update>'],
        ['__proto__']: { x: 1 } });
  });

  it.each([
    '{"x":1,"x":2}', '{"x":{"a":1,"\\u0061":2}}', '[1,]', '{"x":}', '01', '1e999',
    '{"x":"\\q"}', 'true false', '{"x":1} trailing',
  ])('rejects malformed or ambiguous JSON: %s', value => {
    expect(() => parseStrictJson(value)).toThrow();
  });

  it('rejects excessive nesting per value', () => {
    expect(() => parseStrictJson('['.repeat(34) + '0' + ']'.repeat(34))).toThrow();
  });

  it('isolates every nonempty physical JSONL line and preserves valid rows around bad rows', () => {
    const rows = parseJsonl([
      ' \r\n{"path":"coins","value":8}\r\n{"path":"broken","value":\r\n',
      '{"path":"energy","value":10}\n{"path":"x","value":1,"value":2}\n[]\n',
    ]);
    expect(rows.map(row => row.ok ? 'ok' : row.status))
      .toEqual(['ok', 'invalid_json', 'ok', 'invalid_json', 'ok']);
    expect(rows[0]).toEqual({ ok: true, value: { path: 'coins', value: 8 } });
    expect(rows[2]).toEqual({ ok: true, value: { path: 'energy', value: 10 } });
  });

  it('does not combine multiline objects or adjacent objects into a valid update', () => {
    expect(parseJsonl(['{"path":"coins",\n"value":1}\n{} {}\n{"path":"x","value":2}'])
      .map(row => row.ok)).toEqual([false, false, false, true]);
  });

  it('does not apply a 100-row or shared tail size quota', () => {
    expect(parseJsonl(Array.from({ length: 125 }, () => '{"path":"coins","value":8}'))).toHaveLength(125);
    expect(parseStrictJson(JSON.stringify('x'.repeat(270_000)))).toHaveLength(270_000);
  });
});
