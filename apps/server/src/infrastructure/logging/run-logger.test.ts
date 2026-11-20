import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunLogger } from './run-logger.js';

const timestamp = new Date(2026, 10, 20, 18, 32, 5).getTime();
function dataOf(line: string): Record<string, unknown> {
  const data = /^\[[^\]]+\] \[[^\]]+\] \[(.*)\]$/u.exec(line)?.[1];
  expect(data).toBeDefined();
  return JSON.parse(data!);
}

afterEach(() => vi.restoreAllMocks());

describe('run log formatting', () => {
  it('writes one complete line with server-local time and a fixed run identity', () => {
    const lines: string[] = [];
    const identity = { runId: 'r-1', sessionId: 's-1' };
    const log = createRunLogger(identity, line => lines.push(line));
    identity.runId = 'later-mutation';
    const content = '第一行\n第二行\r\n' + '完整正文'.repeat(20_000) + '\u2028\u2029';
    log('model.response', { runId: 'wrong', sessionId: 'wrong', 0: 'numeric field', content }, timestamp);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[2026-11-20 18:32:05\] \[model\.response\] \[\{"runId":"r-1","sessionId":"s-1",/u);
    expect(lines[0]).not.toMatch(/[\r\n\u2028\u2029]/u);
    expect(dataOf(lines[0]!)).toEqual({ runId: 'r-1', sessionId: 's-1', 0: 'numeric field', content });
  });

  it('escapes event labels and keeps simultaneous run loggers independent', () => {
    const lines: string[] = [];
    const first = createRunLogger({ runId: 'first', sessionId: 'one' }, line => lines.push(line));
    const second = createRunLogger({ runId: 'second', sessionId: 'two' }, line => lines.push(line));
    first('run.created]\n[forged\u2028', { text: 'start' }, timestamp);
    second('run.completed', {}, timestamp);
    first('run.usage', { total_tokens: 42 }, timestamp);
    expect(lines.every(line => !/[\r\n\u2028\u2029]/u.test(line))).toBe(true);
    expect(lines[0]).toContain('[run.created\\u005d\\n\\u005bforged\\u2028]');
    expect(lines.map(line => dataOf(line).runId)).toEqual(['first', 'second', 'first']);
    expect(dataOf(lines[2]!)).toMatchObject({ sessionId: 'one', total_tokens: 42 });
  });

  it('redacts explicit credential keys recursively while preserving business data and usage', () => {
    const lines: string[] = [];
    const log = createRunLogger({ runId: 'r', sessionId: 's' }, line => lines.push(line));
    const original = {
      apiKey: 'credential-one', api_key: 'credential-two', credentialRef: 'keychain-ref',
      headers: { Authorization: 'Bearer credential-three', 'X-API-Key': 'credential-four', Cookie: 'session-secret' },
      requests: [{ client_secret: 'credential-five', refreshToken: 'credential-six' }],
      state: { secret: 99, key: 'door', token: 3 },
      usage: { input_tokens: 25, outputTokens: 8, cacheReadTokens: 4 },
    };
    log('model.request', original, timestamp);
    const data = dataOf(lines[0]!);
    expect(data).toMatchObject({
      apiKey: '[REDACTED]', api_key: '[REDACTED]', credentialRef: '[REDACTED]',
      headers: { Authorization: '[REDACTED]', 'X-API-Key': '[REDACTED]', Cookie: '[REDACTED]' },
      requests: [{ client_secret: '[REDACTED]', refreshToken: '[REDACTED]' }],
      state: original.state, usage: original.usage,
    });
    expect(lines[0]).not.toMatch(/credential-|keychain-ref|session-secret/u);
    expect(original.apiKey).toBe('credential-one');
    expect(original.headers.Authorization).toBe('Bearer credential-three');
  });

  it('records errors, big integers and cycles without letting toJSON bypass sanitization', () => {
    const lines: string[] = [];
    const log = createRunLogger({ runId: 'r', sessionId: 's' }, line => lines.push(line));
    const item: Record<string, unknown> = { count: 123n };
    item.self = item;
    const error = Object.assign(new Error('first\nsecond'), { code: 'FAIL', apiKey: 'credential' });
    const custom = { apiKey: 'credential', toJSON: () => 'credential' };
    log('operation.failed', { item, repeated: item, error, custom }, timestamp);
    expect(dataOf(lines[0]!)).toMatchObject({
      item: { count: '123', self: '[Circular]' }, repeated: { count: '123', self: '[Circular]' },
      error: { name: 'Error', message: 'first\nsecond', code: 'FAIL', apiKey: '[REDACTED]' },
      custom: { apiKey: '[REDACTED]', toJSON: '[Function]' },
    });
    expect(lines[0]).not.toContain('credential');
    expect(lines[0]).not.toMatch(/[\r\n]/u);
  });

  it('isolates failing property reads, serialization and sinks from the caller', () => {
    const lines: string[] = [];
    const log = createRunLogger({ runId: 'r', sessionId: 's' }, line => lines.push(line));
    const data = Object.defineProperty({ retained: true }, 'broken', {
      enumerable: true, get() { throw new Error('cannot read'); },
    });
    expect(() => log('safe', data, timestamp)).not.toThrow();
    expect(dataOf(lines[0]!)).toMatchObject({ retained: true, broken: '[Unserializable]' });
    const proxy = new Proxy({}, { ownKeys() { throw new Error('cannot enumerate'); } });
    expect(() => log('safe', proxy, timestamp)).not.toThrow();
    expect(dataOf(lines[1]!)).toEqual({ runId: 'r', sessionId: 's', loggingError: 'serialization_failed' });
    const failingSink = createRunLogger({ runId: 'r', sessionId: 's' }, () => { throw new Error('cannot write'); });
    expect(() => failingSink('safe', {}, timestamp)).not.toThrow();
  });

  it('observes rejected async sinks without awaiting or leaking an unhandled rejection', async () => {
    const sink = vi.fn(async () => { throw new Error('async write failed'); });
    const log = createRunLogger({ runId: 'r', sessionId: 's' }, sink);
    expect(log('run.created', {}, timestamp)).toBeUndefined();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(sink).toHaveBeenCalledOnce();
  });

  it('uses a single console call by default', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    createRunLogger({ runId: 'r', sessionId: 's' })('run.created', { content: 'hello' }, timestamp);
    expect(output).toHaveBeenCalledExactlyOnceWith('[2026-11-20 18:32:05] [run.created] [{"runId":"r","sessionId":"s","content":"hello"}]');
  });
});
