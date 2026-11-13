import { afterEach, expect, it, vi } from 'vitest';
import { debugLog, withDebugContext } from '../src/common/debug.js';
import { runtimeFixture, textGateway, tail, drain, testModel } from './fixtures/runtime-v2.js';
import { ModelClient } from '../src/runtime/model/model-client.js';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/infrastructure/database/database.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const capture = () => {
  vi.stubEnv('SILLYREALMS_DEBUG', '1');
  return vi.spyOn(console, 'log').mockImplementation(() => {});
};
const body = (line: string) => JSON.parse(line.slice(line.indexOf(' | ') + 3));

it('prints a single escaped JSON line, redacts credentials, and survives malformed diagnostics', () => {
  const log = capture();
  const cyclic: Record<string, unknown> = { text: 'first\nsecond\r\n\u2028\u0085', api_key: 'hidden', headers: { Authorization: 'Bearer hidden', Cookie: 'hidden', 'x-api-key': 'hidden' },
    nested: { password: 'hidden', credential_ref: 'hidden' }, echoed: 'key-value', count: 1n };
  cyclic.self = cyclic;
  debugLog('EVENT', cyclic, { context: { runId: 'key-value' }, secrets: ['key-value'] });
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0]).toHaveLength(1);
  const line = String(log.mock.calls[0]![0]);
  expect(line).not.toMatch(/[\r\n\u2028\u0085]/);
  expect(line).toContain('EVENT runId=');
  expect(line).not.toContain('hidden'); expect(line).not.toContain('key-value');
  expect(body(line)).toMatchObject({ text: cyclic.text, self: '[Circular]', count: '1' });
  const repeated = { role: 'user', content: 'same object twice' };
  debugLog('MODEL INPUT', { messages: [repeated,repeated] });
  expect(body(String(log.mock.calls[1]![0])).messages).toEqual([repeated,repeated]);
  log.mockImplementation(() => { throw new Error('broken pipe'); });
  expect(() => debugLog('EVENT', {})).not.toThrow();
});

it('keeps concurrent asynchronous run scopes isolated and stays silent without debug mode', async () => {
  const log = capture();
  await Promise.all(['run-a','run-b'].map(runId => withDebugContext({runId}, async () => {
    await Promise.resolve(); debugLog('EVENT', { label: runId });
  })));
  for (const [value] of log.mock.calls) {
    const line = String(value); expect(line).toContain('runId=' + JSON.stringify(body(line).label));
  }
  log.mockClear(); vi.stubEnv('SILLYREALMS_DEBUG','0'); debugLog('EVENT',{text:'not logged'});
  expect(log).not.toHaveBeenCalled();
});

it('groups a Run around full model input and unparsed output, including hidden extension text', async () => {
  const log = capture(), raw = 'raw story\n' + tail();
  const { db, runtime } = runtimeFixture(textGateway(raw));
  const listener = vi.fn();
  runtime.onEvent(listener);
  try {
    const run = await runtime.prepare('session','debug input','request','opening'); await drain(run.stream);
    const lines = log.mock.calls.map(([value]) => String(value));
    expect(lines.every(line => !/[\r\n]/.test(line))).toBe(true);
    expect(lines.filter(line=>line.includes('RUN BEGIN'))).toHaveLength(1);
    expect(lines.filter(line=>line.includes('RUN END'))).toHaveLength(1);
    expect(lines[0]).toContain('RUN BEGIN'); expect(lines.at(-1)).toContain('RUN END');
    const input = lines.find(line=>line.includes('MODEL INPUT'))!;
    expect(input).toContain(`runId="${run.runId}"`); expect(input).toContain('requestIndex=1'); expect(input).toContain('phase="generation"');
    expect(body(input).messages).toEqual(expect.arrayContaining([expect.objectContaining({role:'user',content:'debug input'})]));
    expect(body(lines.find(line=>line.includes('MODEL OUTPUT'))!).response.content).toEqual([{type:'text',text:raw}]);
    expect(lines.join('')).not.toContain('fake-key');
    expect(lines.some(line=>line.includes('"event":"message.delta"'))).toBe(false);
    expect(listener.mock.calls.some(([,event]) => event === 'message.delta')).toBe(true);
    expect(body(lines.at(-1)!)).toMatchObject({status:'completed'});
  } finally { db.close(); }
});

it('closes a failed preparation without inventing a model call', async () => {
  const log = capture(); const { db, runtime } = runtimeFixture(textGateway('unused'));
  try {
    // A valid persisted config with an unavailable gateway fails during preparation.
    db.prepare("UPDATE api_model_configs SET model_id='missing'").run();
    const gateway = textGateway('unused'); gateway.resolve = () => undefined;
    const { SRRuntime } = await import('../src/runtime/sr-runtime.js');
    const { fakeCredentials } = await import('./fixtures/db-seed.js');
    await expect(new SRRuntime(db, fakeCredentials, gateway).prepare('session','input','request','opening')).rejects.toBeDefined();
    const lines=log.mock.calls.map(([value])=>String(value));
    expect(lines.filter(line=>line.includes('RUN BEGIN'))).toHaveLength(1);
    expect(lines.at(-1)).toContain('RUN END'); expect(lines.some(line=>line.includes('MODEL BEGIN'))).toBe(false);
    expect(runtime.busy('session')).toBe(false);
  } finally { db.close(); }
});

it('prints one HTTP record without logging request credentials', async () => {
  const log = capture(), db = openDatabase(':memory:');
  try {
    const response = await createApp(db).request('/health?api_key=hidden&value=a%0Ab');
    expect(response.status).toBe(200);
    const lines=log.mock.calls.map(([value])=>String(value));
    expect(lines).toHaveLength(1); expect(lines[0]).toContain('HTTP | '); expect(lines[0]).not.toContain('hidden');
    expect(body(lines[0]!)).toMatchObject({status:200,query:{api_key:'[REDACTED]',value:'a\nb'}});
  } finally { db.close(); }
});

it('logs partial provider output once on cancellation with its call index', async () => {
  const log = capture(), controller = new AbortController();
  const gateway = textGateway('unused');
  gateway.stream = () => ({ async *[Symbol.asyncIterator]() {
    yield {type:'text_delta',delta:'unfinished\ntext',contentIndex:0,partial:{} as never} as const;
    await new Promise<void>(resolve => controller.signal.addEventListener('abort',()=>resolve(),{once:true}));
  }});
  const client = new ModelClient(gateway);
  const stream = client.events(testModel,{messages:[]},{apiKey:'private-key',signal:controller.signal,maxTokens:100},
    {sessionId:'s',runId:'r',requestId:'q',requestIndex:2,phase:'continuation'});
  await stream.next(); const pending = stream.next(); controller.abort(); await pending;
  const output = log.mock.calls.map(([value])=>String(value)).filter(line=>line.includes('MODEL OUTPUT'));
  expect(output).toHaveLength(1); expect(output[0]).toContain('requestIndex=2');
  expect(body(output[0]!)).toMatchObject({status:'aborted',source:'partial',response:{content:[{type:'text',text:'unfinished\ntext'}]}});
});
