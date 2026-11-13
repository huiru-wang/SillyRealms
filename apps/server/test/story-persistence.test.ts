import { expect, it, vi } from 'vitest';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { runtimeFixture, response, tail, textGateway } from './fixtures/runtime-v2.js';
import { RunStore } from '../src/runtime/persistence/run-store.js';
import { recoverInterrupted } from '../src/infrastructure/database/database.js';

it.each(['completed', 'stopped', 'failed'] as const)('buffers narrative until %s, preserving its ID in snapshots and storage', async outcome => {
  let resume!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const visible = new Promise<void>(resolve => { observed = resolve; });
  const gateway = textGateway('');
  gateway.stream = (_model, _context, { signal }) => ({ async *[Symbol.asyncIterator]() {
    signal.addEventListener('abort', resume, { once: true });
    yield { type: 'text_delta', delta: 'A😀', contentIndex: 0, partial: {} } as AssistantMessageEvent;
    await gate;
    if (outcome === 'failed') throw new Error('simulated provider failure');
    if (signal.aborted) return;
    const remaining = 'B' + tail();
    yield { type: 'text_delta', delta: remaining, contentIndex: 0, partial: {} } as AssistantMessageEvent;
    yield { type: 'done', reason: 'stop', message: response('A😀' + remaining) } as AssistantMessageEvent;
  } });
  const { db, runtime } = runtimeFixture(gateway);
  const events: Record<string, unknown>[] = [];
  runtime.onEvent((_session, event, data) => { if (event === 'message.delta') { events.push(data); observed(); } });
  try {
    const { runId } = await runtime.start('session', 'go', 'request', 'opening');
    await visible;
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE run_id=? AND role='assistant'").get(runId)!.n).toBe(0);
    expect(new RunStore(db).status('session', runId)!.messages.map((m: { text: string }) => m.text)).toEqual(['go']);
    const snapshot = runtime.status('session', runId)!;
    expect(snapshot.messages.map((m: { text: string }) => m.text)).toEqual(['go', 'A😀']);
    const tip = String(db.prepare("SELECT tip_entry_id FROM sessions WHERE id='session'").get()!.tip_entry_id);
    expect(runtime.history('session', tip, 5).runs.at(-1)!.messages).toEqual(snapshot.messages);
    expect(events[0]).toMatchObject({ offset: 0, text: 'A😀' });
    if (outcome === 'stopped') await runtime.stop('session', runId);
    else { resume(); await vi.waitFor(() => expect(runtime.busy('session')).toBe(false)); }
    const saved = new RunStore(db).status('session', runId)!;
    expect(saved.status).toBe(outcome);
    expect(saved.messages[1]).toEqual({ id: snapshot.messages[1].id, role: 'assistant', text: outcome === 'completed' ? 'A😀B' : 'A😀' });
    expect(db.prepare("SELECT count(*) AS n FROM entries WHERE run_id=? AND role='assistant'").get(runId)!.n).toBe(1);
    if (outcome === 'completed') expect(events[1]).toMatchObject({ offset: 3, text: 'B' });
  } finally { resume(); await runtime.stopActive('session'); db.close(); }
});

it('recovers only durable input after process death, without inventing unfinished narrative', async () => {
  let observed!: () => void;
  const visible = new Promise<void>(resolve => { observed = resolve; });
  const gateway = textGateway('');
  gateway.stream = (_model, _context, { signal }) => ({ async *[Symbol.asyncIterator]() {
    yield { type: 'text_delta', delta: 'memory only', contentIndex: 0, partial: {} } as AssistantMessageEvent;
    await new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  } });
  const { db, runtime } = runtimeFixture(gateway);
  runtime.onEvent((_session, event) => { if (event === 'message.delta') observed(); });
  try {
    const { runId } = await runtime.start('session', 'durable input', 'request', 'opening');
    await visible;
    // Startup recovery only sees the database, not the prior process's RunTask.
    recoverInterrupted(db);
    const recovered = new RunStore(db).status('session', runId)!;
    expect(recovered.status).toBe('failed');
    expect(recovered.errorCode).toBe('RUN_INTERRUPTED');
    expect(recovered.messages.map((message: { text: string }) => message.text)).toEqual(['durable input']);
  } finally { await runtime.stopActive('session'); db.close(); }
});
