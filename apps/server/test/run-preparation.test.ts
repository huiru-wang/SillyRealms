import { expect, it } from 'vitest';
import { runtimeFixture, textGateway, tail, drain } from './fixtures/runtime-v2.js';
import { sessionRuntimeRoutes } from '../src/routes/session-runtime.js';
import { UsageStore } from '../src/runtime/persistence/usage-store.js';
import { RunStore } from '../src/runtime/persistence/run-store.js';
import { recoverInterrupted } from '../src/infrastructure/database/database.js';
import { fakeCredentials } from './fixtures/db-seed.js';
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

it('saves input before acceptance, returns it only on query, and retries once with a new requestId', async () => {
  let calls = 0;
  const gateway = textGateway('story' + tail());
  const stream = gateway.stream;
  gateway.stream = (...args) => { calls++; return stream(...args); };
  const { db, runtime, preset } = runtimeFixture(gateway);
  const routes = sessionRuntimeRoutes(db, runtime), reader = (await routes.request('/session/events')).body!.getReader();
  try {
    db.prepare('UPDATE presets SET config_json=?').run(JSON.stringify({ ...preset, budget: { ...preset.budget, max_context_tokens: 999999 } }));
    const text = 'PRIVATE recoverable input', requestId = crypto.randomUUID();
    const accepted = await routes.request('/session/runs', json({ text, requestId, expectedTipEntryId: 'opening' }));
    expect(accepted.status).toBe(202);
    const { runId } = (await accepted.json() as any).data;
    expect(db.prepare('SELECT input_text FROM run_preparations WHERE run_id=?').get(runId)?.input_text).toBe(text);
    let events = '';
    while (!events.includes('event: run.failed')) events += new TextDecoder().decode((await reader.read()).value);
    expect(events).not.toContain(text);
    const event = JSON.parse(/event: run.failed\ndata: ([^\n]+)/.exec(events)![1]!);
    const result = (await (await routes.request('/session/runs/' + runId)).json() as any).data;
    expect(result).toMatchObject({ status: 'failed', messages: [], input: { text },
      errorCode: 'INVALID_PRESET_BUDGET', failure: { stage: 'preparation', type: 'configuration' },
      recovery: { inputSaved: true, action: 'adjust_configuration' }, tipEntryId: 'opening' });
    expect(event.failure).toEqual(result.failure); expect(event.recovery).toEqual(result.recovery);
    expect(calls).toBe(0);
    expect(await (await routes.request('/session/usage')).text()).not.toContain(text);
    expect((await routes.request('/session/runs', json({ text, requestId, expectedTipEntryId: 'opening' }))).status).toBe(409);
    db.prepare('UPDATE presets SET config_json=?').run(JSON.stringify(preset));
    const retry = await runtime.prepare('session', text, crypto.randomUUID(), 'opening'); await drain(retry.stream);
    expect(runtime.status('session', retry.runId)?.status).toBe('completed'); expect(calls).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE role='user'").get()!.n).toBe(1);
    expect(runtime.status('session', runId)).toMatchObject({ input: { text } });
    expect(db.prepare('SELECT count(*) AS n FROM run_preparations').get()!.n).toBe(1);
  } finally { await reader.cancel(); db.close(); }
});
it('keeps more than 64 failed inputs without advancing history or repeating settlement', async () => {
  const { db, runtime, preset } = runtimeFixture(textGateway('unused'));
  try {
    preset.budget.max_context_tokens = 999999;
    db.prepare('UPDATE presets SET config_json=?').run(JSON.stringify(preset));
    let first = '';
    for (let i = 0; i < 66; i++) {
      await expect(runtime.prepare('session', 'saved ' + i, 'request-' + i, 'opening')).rejects.toMatchObject({ code: 'INVALID_PRESET_BUDGET' });
      if (!first) first = String(db.prepare('SELECT run_id FROM run_preparations').get()!.run_id);
    }
    expect(db.prepare('SELECT count(*) AS n FROM run_preparations WHERE accounted=1').get()!.n).toBe(66);
    expect(runtime.status('session', first)).toMatchObject({ input: { text: 'saved 0' } });
    expect(db.prepare('SELECT count(*) AS n FROM entries').get()!.n).toBe(1);
    expect(new UsageStore(db).settleRun('session', first, 'failed')).toBe(false);
    expect(new UsageStore(db).view('session').cumulative).toMatchObject({ reportedCount: 0, unknownCount: 0 });
  } finally { db.close(); }
});
it('stops preparation while a credential promise is pending and preserves the accepted input', async () => {
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  const { db, runtime } = runtimeFixture(textGateway('unused'), 'direct', {
    ...fakeCredentials, get: async () => { entered(); await gate; return 'fake'; },
  });
  try {
    const accepted = await runtime.start('session', 'keep on cancel', 'cancel', 'opening'); await ready;
    const stopped = await runtime.stop('session', accepted.runId);
    expect(stopped).toMatchObject({ status: 'stopped', messages: [], input: { text: 'keep on cancel' }, recovery: { inputSaved: true, action: 'resubmit' } });
    expect(runtime.busy('session')).toBe(false);
    expect(db.prepare('SELECT tip_entry_id FROM sessions').get()!.tip_entry_id).toBe('opening');
  } finally { release(); db.close(); }
});
it.each([true, false])('recovers a crash during preparation exactly once (journal present=%s)', journal => {
  const { db, runtime } = runtimeFixture(textGateway('unused'));
  try {
    const store = new RunStore(db), usage = new UsageStore(db);
    store.beginPreparation({ sessionId: 'session', runId: 'crash', requestId: 'crash-request', input: 'keep after restart', expectedTip: 'opening' },
      () => usage.beginRun('session', 'crash', 'crash-request'));
    if (journal) usage.beginRequest({ sessionId: 'session', runId: 'crash', requestId: 'summary', phase: 'summary' }, 'fake', 32768);
    else db.exec("UPDATE sessions SET usage_json=json_set(usage_json,'$.pendingRun',NULL)");
    recoverInterrupted(db); const first = new UsageStore(db).view('session'); recoverInterrupted(db);
    expect(new UsageStore(db).view('session')).toEqual(first);
    expect(first.cumulative.unknownCount).toBe(journal ? 1 : 0);
    expect(runtime.status('session', 'crash')).toMatchObject({ status: 'failed', errorCode: 'RUN_INTERRUPTED',
      failure: { stage: 'preparation', type: 'interrupted' }, input: { text: 'keep after restart' }, recovery: { inputSaved: true } });
    expect(db.prepare('SELECT count(*) AS n FROM entries').get()!.n).toBe(1);
  } finally { db.close(); }
});
it('rolls back the acceptance journal if input persistence fails', async () => {
  const { db, runtime } = runtimeFixture(textGateway('unused'));
  try {
    db.exec("CREATE TRIGGER reject_prep BEFORE INSERT ON run_preparations BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(runtime.start('session', 'unsaved', 'request', 'opening')).rejects.toThrow();
    expect(JSON.parse(String(db.prepare('SELECT usage_json FROM sessions').get()!.usage_json)).pendingRun).toBeNull();
    expect(runtime.busy('session')).toBe(false);
  } finally { db.close(); }
});
it('does not announce or settle a terminal outcome when both terminal writes fail',async()=>{
  const {db,runtime}=runtimeFixture(textGateway('story'+tail()));
  const terminal:string[]=[];
  runtime.onEvent((_session,event,payload)=>{if(event==='run.updated'&&['failed','completed'].includes(String(payload.status)))terminal.push(String(payload.status));});
  try{
    db.exec("CREATE TRIGGER reject_terminal BEFORE UPDATE OF ext_data ON entries WHEN OLD.role='user' AND json_extract(NEW.ext_data,'$.run.phase')='finalized' BEGIN SELECT RAISE(ABORT,'injected'); END");
    const run=await runtime.prepare('session','keep','failed-commit','opening');await drain(run.stream);
    expect(terminal).toEqual([]);expect(runtime.status('session',run.runId)?.status).toBe('running');
    expect(JSON.parse(String(db.prepare('SELECT usage_json FROM sessions').get()!.usage_json)).pendingRun.runId).toBe(run.runId);
    db.exec('DROP TRIGGER reject_terminal');recoverInterrupted(db);
    expect(runtime.status('session',run.runId)).toMatchObject({status:'failed',errorCode:'RUN_INTERRUPTED'});
    expect(new UsageStore(db).view('session').cumulative.reportedCount).toBe(1);
  }finally{db.close();}
});
it('reports legacy interrupted usage without inventing a recoverable input',()=>{
  const {db,runtime}=runtimeFixture(textGateway('unused'));
  try{
    new UsageStore(db).beginRun('session','legacy-preparation','legacy-request');recoverInterrupted(db);
    const result=runtime.status('session','legacy-preparation');
    expect(result).toMatchObject({status:'failed',messages:[],errorCode:'RUN_INTERRUPTED',recovery:{inputSaved:false}});
    expect(result).not.toHaveProperty('input');
  }finally{db.close();}
});
it('retains the accepted journal when preparation settlement fails and emits no false terminal',async()=>{
  const {db,runtime,preset}=runtimeFixture(textGateway('unused'));
  const events:string[]=[];runtime.onEvent((_id,event,payload)=>{if(event==='run.updated'&&payload.status==='failed')events.push(event);});
  try{
    preset.budget.max_context_tokens=999999;db.prepare('UPDATE presets SET config_json=?').run(JSON.stringify(preset));
    db.exec("CREATE TRIGGER reject_prep_terminal BEFORE UPDATE ON run_preparations WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'injected'); END");
    await expect(runtime.prepare('session','durable input','settlement','opening')).rejects.toThrow();
    const prep=db.prepare('SELECT * FROM run_preparations').get()!;
    expect(prep).toMatchObject({status:'preparing',input_text:'durable input',accounted:0});expect(events).toEqual([]);
    expect(JSON.parse(String(db.prepare('SELECT usage_json FROM sessions').get()!.usage_json)).pendingRun.runId).toBe(prep.run_id);
    db.exec('DROP TRIGGER reject_prep_terminal');recoverInterrupted(db);
    expect(runtime.status('session',String(prep.run_id))).toMatchObject({status:'failed',errorCode:'RUN_INTERRUPTED',input:{text:'durable input'}});
  }finally{db.close();}
});
