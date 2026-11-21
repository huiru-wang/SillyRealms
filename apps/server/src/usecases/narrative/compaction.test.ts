import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../errors.js';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { EventHub } from '../../infrastructure/events/event-hub.js';
import type { ModelClient, ModelEvent, ModelInfo, ModelUsage } from '../../infrastructure/model/client.js';
import { createServices, type Services } from '../../services.js';
import { memoryCredentials } from '../../testing/credentials.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { createNarrativeUsecases, type NarrativeUsecases } from './index.js';
import type { NarrativeEvent, NarrativeTerminalEvent } from './events.js';
import { createAppendEntry } from '../append-entry.js';
import { bindTransaction } from '../../infrastructure/database/transaction.js';

const model: ModelInfo = {
  providerId: 'provider', modelId: 'model', name: 'Model', contextWindow: 64000, maxTokens: 8192,
  api: 'test', input: ['text'], reasoning: false, thinkingLevels: ['off'], thinkingLevelMap: null,
  promptCache: null, narrativeCompatible: true, supportsMidConversationSystemMessages: true,
};
const usage: ModelUsage = { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 };
function done(content = 'summary', measured: ModelUsage | null = usage): ModelEvent {
  return { type: 'done', finishReason: 'stop', usage: measured,
    snapshot: { role: 'assistant', content, reasoning_content: '', tool_calls: [] } };
}
let db: DatabaseSync, root: string, services: Services, hub: EventHub, narrative: NarrativeUsecases;
let stream: ReturnType<typeof vi.fn<ModelClient['stream']>>, seen: NarrativeEvent[];
beforeEach(async () => {
  db = openDatabase(':memory:'); root = mkdtempSync(join(tmpdir(), 'sr-compaction-'));
  services = createServices(db, root, memoryCredentials());
  const credentialRef = services.credentials.referenceFor('model');
  await services.credentials.set(credentialRef, 'test');
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef });
  const preset = narrativePreset(); preset.config.contextStrategy.maxContextTokens = 1500;
  services.presets.create({ ...preset, id: 'preset' });
  services.worlds.create({ id: 'world', name: 'World', specVersion: '0.1',
    characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'opening', name: 'Opening', content: 'Start' }],
  });
  services.sessions.create({ id: 'session', worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' });
  hub = new EventHub(); seen = [];
  hub.subscribe('session', event => seen.push(structuredClone(event) as NarrativeEvent));
  stream = vi.fn<ModelClient['stream']>(async function* () { yield { type: 'request_started' }; yield done(); });
  narrative = createNarrativeUsecases({ ...services, events: hub, transaction: bindTransaction(db),
    modelClient: { resolve: () => model, assertMessageOrder: vi.fn(), stream },
  });
});
afterEach(async () => {
  await narrative.shutdown(); vi.restoreAllMocks(); db.close(); rmSync(root, { recursive: true, force: true });
});
function seed(oldSize = 7000) {
  for (let i = 0; i < 8; i++) services.sessions.appendEntry('session', {
    id: 'old-' + i, runId: 'past-' + i, type: 'message', role: 'assistant',
    payload: { message: { role: 'assistant', content: i < 3 ? 'Old story ' + 'x'.repeat(oldSize) : 'Recent ' + i, timestamp: i } },
  });
  services.sessions.setEntryState('session', 'old-7', [{ key: 'coins', value: 3 }]);
}
function submit(sessionId = 'session') {
  const finished = new Promise<NarrativeTerminalEvent>(resolve => {
    const unsubscribe = hub.subscribe(sessionId, event => {
      if (event.event === 'run.completed' || event.event === 'run.stopped') {
        unsubscribe(); resolve(event as NarrativeTerminalEvent);
      }
    });
  });
  const accepted = narrative.submit({ sessionId, input: { text: 'Current input' },
    expectedTipEntryId: services.sessions.require(sessionId).tipEntryId });
  return { accepted, finished };
}
const summaries = () => services.sessions.getHistory('session').filter(entry => entry.type === 'compaction');
const total = () => seen.filter(event => event.event === 'run.usage').at(-1)?.data.usage;

describe('summary execution and accounting', () => {
  it('forwards the saved thinking depth through both summary and main narrative requests', async () => {
    const preset = services.presets.require('preset');
    services.presets.update(preset.id, { config: {
      ...preset.config, modelParameters: { thinkingEnabled: true, thinkingLevel: 'xhigh' },
    } });
    seed();
    expect(await submit().finished).toMatchObject({ event: 'run.completed' });
    expect(stream).toHaveBeenCalledTimes(2);
    for (const [, , request] of stream.mock.calls) {
      expect(request).toMatchObject({ thinkingEnabled: true, thinkingLevel: 'xhigh' });
    }
  });

  it('saves one summary before generation, publishes only summary milestones, and accounts requests once', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    stream.mockImplementation(async function* (selected, messages, options) {
      options.onDiagnostic?.({ type: 'request', source: 'provider_payload', data: { model: selected.modelId, messages } });
      yield { type: 'request_started' };
      options.onDiagnostic?.({ type: 'response', source: 'sdk_message', data: { content: 'summary', usage } });
      yield done();
    });
    seed();
    let savedWhenNotified = false;
    hub.subscribe('session', event => {
      if (event.event === 'run.summarized') savedWhenNotified = services.sessions.getEntry('session', event.data.entryId as string)?.metrics !== null;
    });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.completed', data: { savedMessageIds: [accepted.userEntryId, accepted.assistantEntryId] } });
    const summary = summaries()[0]!;
    expect(savedWhenNotified).toBe(true);
    expect(summary).toMatchObject({ parentId: accepted.userEntryId, runId: accepted.runId, role: null, state: null,
      payload: { summary: 'summary' }, extData: { summary: { coveredThroughEntryId: 'old-2', sourceHash: expect.any(String) } },
      metrics: { requests: [{ provider: 'provider', modelId: 'model', usage }] },
    });
    expect(services.sessions.getEntry('session', accepted.assistantEntryId)?.parentId).toBe(summary.id);
    expect(services.state.getCurrentMessage('session')).toEqual({ coins: 3 });
    expect(seen.map(event => event.event)).toEqual(['run.created', 'run.summarizing', 'run.summarized', 'run.delta', 'run.usage', 'run.completed']);
    expect(seen.every(event => !('phase' in event.data))).toBe(true);
    expect(stream).toHaveBeenCalledTimes(2);
    const summaryInput = JSON.parse(stream.mock.calls[0]![1][1]!.content);
    expect(summaryInput.messages).toHaveLength(3);
    expect(JSON.stringify(summaryInput)).not.toContain('Current input');
    const generation = stream.mock.calls[1]![1].slice(0, -1).map(message => message.content);
    expect(generation).toEqual(['summary', 'Recent 3', 'Recent 4', 'Recent 5', 'Recent 6', 'Recent 7', 'Current input']);
    expect(total()).toMatchObject({ total_tokens: 50 });
    expect(services.sessions.recordedUsage('session')).toMatchObject({ recordedRequestCount: 2, knownUsage: { totalTokens: 50 } });
    expect(narrative.list('session', {}).items[0]?.entries.map(entry => entry.type)).toEqual(['message', 'compaction', 'message']);
    const logs = lines.map(line => {
      const match = /^\[[^\]]+\] \[([^\]]+)\] \[(.*)\]$/u.exec(line)!;
      return { event: match[1], data: JSON.parse(match[2]!) };
    });
    expect(logs.filter(item => item.event === 'model.request' || item.event === 'model.response')
      .map(item => [item.event, item.data.purpose])).toEqual([
      ['model.request', 'summary'], ['model.response', 'summary'],
      ['model.request', 'narrative'], ['model.response', 'narrative'],
    ]);
    expect(logs.filter(item => item.event === 'context.completed')).toHaveLength(1);
    expect(logs.findIndex(item => item.event === 'context.completed')).toBeGreaterThan(
      logs.findIndex(item => item.event === 'run.summarized'));
    expect(logs.every(item => item.data.runId === accepted.runId)).toBe(true);

  });

  it('stops after one over-capacity summary, keeps it and its metrics, then can submit from the compaction tip', async () => {
    seed();
    stream.mockImplementationOnce(async function* () { yield { type: 'request_started' }; yield done('s'.repeat(9000)); });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'summary_capacity_exceeded', savedMessageIds: [accepted.userEntryId] } });
    expect(stream).toHaveBeenCalledTimes(1);
    const summary = summaries()[0]!;
    expect(services.sessions.require('session').tipEntryId).toBe(summary.id);
    expect(services.sessions.getNarrativeOutcome(services.sessions.getEntry('session', accepted.userEntryId)!)).toMatchObject({ stopReason: 'summary_capacity_exceeded' });
    expect(total()).toMatchObject({ total_tokens: 25 });
    const preset = services.presets.require('preset'); preset.config.contextStrategy.maxContextTokens = 20000;
    services.presets.update('preset', { config: preset.config });
    expect(await submit().finished).toMatchObject({ event: 'run.completed' });
    expect(summaries()).toHaveLength(1);
  });

  it.each(['provider', 'length', 'empty', 'tool', 'incomplete'] as const)('discards %s summary output and all of its accounting', async kind => {
    seed();
    stream.mockImplementation(async function* () {
      yield { type: 'request_started' };
      yield { type: 'delta', delta: { content: 'Unfinished summary' } };
      if (kind === 'incomplete') return;
      const event = done(kind === 'empty' ? ' ' : 'Partial') as Extract<ModelEvent, { type: 'done' }>;
      if (kind === 'provider') yield { type: 'error', snapshot: event.snapshot, usage, stopReason: 'provider_error' };
      else yield { ...event, finishReason: kind === 'length' ? 'length' : kind === 'tool' ? 'tool_calls' : 'stop' };
    });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'summary_failed' } });
    expect(summaries()).toEqual([]);
    expect(services.sessions.listEntryRuns('session').items.find(item => item.runId === accepted.runId)!.entries).toHaveLength(1);
    expect(total()).toMatchObject({ total_tokens: 0 });
    expect(services.sessions.recordedUsage('session').recordedRequestCount).toBe(0);
    expect(seen.map(event => event.event)).toEqual(['run.created', 'run.summarizing', 'run.usage', 'run.stopped']);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('saves successful summary usage as null when unknown and retains ordinary failed-generation metrics', async () => {
    seed();
    stream.mockImplementationOnce(async function* () { yield { type: 'request_started' }; yield done('Summary', null); })
      .mockImplementationOnce(async function* () {
        yield { type: 'request_started' };
        yield { type: 'error', snapshot: { role: 'assistant', content: 'Partial narrative', reasoning_content: '', tool_calls: [] },
          usage: null, stopReason: 'provider_error' };
      });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ event: 'run.stopped', data: { stop_reason: 'provider_error' } });
    expect(summaries()[0]?.metrics?.requests[0]?.usage).toBeNull();
    expect(services.sessions.getEntry('session', accepted.assistantEntryId)?.metrics?.requests[0]?.usage).toBeNull();
    expect(total()).toBeNull();
    expect(services.sessions.recordedUsage('session')).toMatchObject({ recordedRequestCount: 2, unknownUsageRequestCount: 2 });
  });

  it('uses the final snapshot rather than requiring summary deltas to match it', async () => {
    seed();
    stream.mockImplementationOnce(async function* () {
      yield { type: 'request_started' }; yield { type: 'delta', delta: { content: 'Draft' } }; yield done('Revised summary');
    });
    await submit().finished;
    expect(summaries()[0]?.payload.summary).toBe('Revised summary');
    expect(stream.mock.calls[1]?.[1][0]?.content).toBe('Revised summary');
  });

  it('cancels a stalled summary, releases the execution lock and ignores late output', async () => {
    seed();
    let unblock!: (value: IteratorResult<ModelEvent>) => void;
    let pending!: () => void;
    const waiting = new Promise<void>(resolve => { pending = resolve; });
    stream.mockImplementationOnce(() => ({ [Symbol.asyncIterator]() {
      let started = false;
      return { next: () => {
        if (!started) { started = true; return Promise.resolve({ done: false as const, value: { type: 'request_started' as const } }); }
        pending(); return new Promise<IteratorResult<ModelEvent>>(resolve => { unblock = resolve; });
      }, return: () => new Promise<IteratorResult<ModelEvent>>(() => {}) };
    } }));
    const { accepted, finished } = submit();
    await waiting;
    expect(() => submit()).toThrow('RUN_ALREADY_ACTIVE');
    narrative.stop('session', accepted.runId);
    expect(await finished).toMatchObject({ data: { stop_reason: 'cancelled' } });
    expect(summaries()).toEqual([]);
    expect(total()).toMatchObject({ total_tokens: 0 });
    unblock({ done: false, value: done('Too late') });
    expect(await submit().finished).toMatchObject({ event: 'run.completed' });
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]?.payload.summary).not.toBe('Too late');
  });

  it('keeps a committed summary when stopped between summary and narrative and holds the lock through notification', async () => {
    seed();
    let refused = false;
    hub.subscribe('session', event => {
      if (event.event === 'run.summarized') {
        try { narrative.submit({ sessionId: 'session', input: { text: 'Other' }, expectedTipEntryId: services.sessions.require('session').tipEntryId }); }
        catch (error) { refused = error instanceof AppError && error.code === 'RUN_ALREADY_ACTIVE'; }
        narrative.stop('session', event.data.runId as string);
      }
    });
    expect(await submit().finished).toMatchObject({ data: { stop_reason: 'cancelled' } });
    expect(refused).toBe(true);
    expect(summaries()).toHaveLength(1);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(total()).toMatchObject({ total_tokens: 25 });
  });

  it('discards an unfinished summary on shutdown and does not lock another session', async () => {
    seed();
    services.sessions.create({ id: 'other', worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' });
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    stream.mockImplementationOnce(async function* () {
      yield { type: 'request_started' }; started(); await new Promise(() => {});
    });
    const run = submit(); await waiting;
    expect(await submit('other').finished).toMatchObject({ event: 'run.completed' });
    await narrative.shutdown();
    expect(await run.finished).toMatchObject({ data: { stop_reason: 'server_shutdown' } });
    expect(summaries()).toEqual([]);
    expect(total()).toMatchObject({ total_tokens: 0 });
  });

  it('keeps the user if summary persistence fails and releases the lock', async () => {
    seed();
    const original = services.sessions.appendEntry.bind(services.sessions);
    const write = vi.spyOn(services.sessions, 'appendEntry').mockImplementation((id, input, permit) => {
      if (input.type === 'compaction') throw new Error('disk');
      return original(id, input, permit);
    });
    const { accepted, finished } = submit();
    expect(await finished).toMatchObject({ data: { stop_reason: 'message_persist_failed', savedMessageIds: [accepted.userEntryId] } });
    expect(summaries()).toEqual([]);
    expect(total()).toMatchObject({ total_tokens: 0 });
    write.mockRestore();
    expect(await submit().finished).toMatchObject({ event: 'run.completed' });
  });

  it('rejects a summary request over the model input budget without invoking a model', async () => {
    seed(70000);
    expect(await submit().finished).toMatchObject({ data: { stop_reason: 'summary_capacity_exceeded' } });
    expect(stream).not.toHaveBeenCalled();
    expect(seen.map(event => event.event)).toEqual(['run.created', 'run.usage', 'run.stopped']);
  });

  it('reuses a valid summary, invalidates it after covered prose changes, and never duplicates covered history', async () => {
    seed(); await submit().finished;
    expect(await submit().finished).toMatchObject({ event: 'run.completed' });
    expect(stream).toHaveBeenCalledTimes(3); expect(summaries()).toHaveLength(1);
    expect(stream.mock.calls[2]?.[1].some(message => message.content.includes('Old story'))).toBe(false);
    services.sessions.setEntryState('session', 'old-0', [{ key: 'coins', value: 100 }]);
    await submit().finished;
    expect(summaries()).toHaveLength(1);
    services.sessions.updateEntry('session', 'old-0', { payload: { message: { role: 'assistant', content: 'Edited story ' + 'e'.repeat(7000), timestamp: 0 } } });
    await submit().finished;
    expect(summaries()).toHaveLength(2);
    expect(stream.mock.calls[4]?.[1][1]?.content).toContain('Edited story');
  });

  it('merges the previous summary with only newly covered history and preserves seq-based catch-up', async () => {
    seed(); await submit().finished;
    const first = summaries()[0]!;
    for (let i = 0; i < 7; i++) services.sessions.appendEntry('session', {
      id: 'new-' + i, runId: 'new-run-' + i, type: 'message', role: 'user',
      payload: { message: { role: 'user', content: 'New story ' + 'n'.repeat(1200), timestamp: 100 + i } },
    });
    const run = submit(); await run.finished;
    const input = JSON.parse(stream.mock.calls[2]![1][1]!.content);
    expect(input.previousSummary).toBe(first.payload.summary);
    expect(input.messages[0].content).toBe('Recent 3');
    expect(JSON.stringify(input)).not.toContain('Old story');
    const second = summaries()[1]!;
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(second.extData.summary).toMatchObject({ coveredThroughEntryId: 'new-1' });
    expect(narrative.list('session', { afterSeq: second.seq - 1 }).items[0]?.entries.map(entry => entry.id))
      .toEqual([run.accepted.userEntryId, second.id]);
    expect(services.sessions.getNarrativeOutcome(services.sessions.getEntry('session', run.accepted.userEntryId)!))
      .toMatchObject({ stopReason: 'summary_capacity_exceeded' });
  });

  it('protects summary creation and metadata from generic entry mutations', async () => {
    seed(); await submit().finished;
    const entry = summaries()[0]!;
    expect(() => services.sessions.updateEntry('session', entry.id, { payload: { summary: 'Forged' } })).toThrow('INVALID_REQUEST');
    expect(() => services.sessions.updateEntry('session', entry.id, { extData: {} })).toThrow('INVALID_REQUEST');
    expect(() => services.sessions.updateEntry('session', 'old-0', { extData: { summary: {} } })).toThrow();
    const append = createAppendEntry({ sessions: services.sessions, state: services.state, events: hub, transaction: bindTransaction(db) });
    expect(() => append('session', { runId: 'forged', type: 'compaction', role: null, payload: { summary: 'Forged' } })).toThrow('INVALID_REQUEST');
  });
});
