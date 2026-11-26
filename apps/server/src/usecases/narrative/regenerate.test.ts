import { worldPublication } from '../../testing/fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { bindTransaction } from '../../infrastructure/database/transaction.js';
import { EventHub } from '../../infrastructure/events/event-hub.js';
import type {
  ModelClient, ModelEvent, ModelInfo, ModelSnapshot, ModelUsage,
} from '../../infrastructure/model/client.js';
import { createServices, type Services } from '../../services.js';
import { memoryCredentials } from '../../testing/credentials.js';
import { narrativePreset } from '../../testing/fixtures.js';
import type { NarrativeEvent, NarrativeTerminalEvent } from './events.js';
import { createNarrativeUsecases, type NarrativeUsecases } from './index.js';

const model: ModelInfo = {
  modelId: 'story-model', name: 'Story model', providerId: 'test-provider', api: 'openai-completions',
  reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 8192,
  thinkingLevels: ['off'], thinkingLevelMap: null, promptCache: null,
  narrativeCompatible: true, supportsMidConversationSystemMessages: false,
};
const usage: ModelUsage = { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 0 };
const snapshot = (content = '', extra: Partial<ModelSnapshot> = {}): ModelSnapshot => ({
  role: 'assistant', content, reasoning_content: '', tool_calls: [], ...extra,
});
const done = (content = '完整正文', extra: Partial<Extract<ModelEvent, { type: 'done' }>> = {}): ModelEvent => ({
  type: 'done', snapshot: snapshot(content), finishReason: 'stop', usage, ...extra,
});
const text = (content: string): ModelEvent => ({ type: 'delta', delta: { content } });

let db: DatabaseSync, services: Services, dataRoot: string;
let logLines: string[];
let events: EventHub, narrative: NarrativeUsecases, seen: NarrativeEvent[];
let stream: ReturnType<typeof vi.fn<ModelClient['stream']>>;
let resolveModel: ReturnType<typeof vi.fn<ModelClient['resolve']>>;

beforeEach(async () => {
  logLines = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { logLines.push(line); });
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-narrative-run-'));
  services = createServices(db, dataRoot, memoryCredentials());
  const credentialRef = services.credentials.referenceFor('model');
  await services.credentials.set(credentialRef, 'private-test-secret');
  services.models.create({ id: 'model', name: 'Model', providerId: model.providerId, modelId: model.modelId, credentialRef });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', name: 'World', specVersion: '0.2', publication: worldPublication(), state: { day: 1 },
    characters: [{ id: 'player', name: 'Player', player_selectable: true }],
    openings: [{ id: 'start', name: 'Start', content: 'An unused opening' }],
  });
  createSession('session');
  events = new EventHub();
  seen = [];
  events.subscribe('session', event => seen.push(structuredClone(event) as NarrativeEvent));
  stream = vi.fn<ModelClient['stream']>(async function* () {
    yield { type: 'request_started' };
    yield text('完整');
    yield text('正文');
    yield done();
  });
  resolveModel = vi.fn<ModelClient['resolve']>(() => model);
  narrative = createNarrativeUsecases({
    ...services, events, transaction: bindTransaction(db), modelClient: { resolve: resolveModel, assertMessageOrder: vi.fn(), stream },
  });
});

afterEach(async () => {
  await narrative.shutdown(); vi.restoreAllMocks(); db.close(); rmSync(dataRoot, {recursive:true, force:true});
});
function createSession(id: string) {
  return services.sessions.create({
    id, worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player',
    state: { coins: 2 },
  });
}
function terminal(sessionId = 'session') {
  return new Promise<NarrativeTerminalEvent>(resolve => {
    const unsubscribe = events.subscribe(sessionId, event => {
      if (event.event === 'run.completed' || event.event === 'run.stopped') {
        unsubscribe();
        resolve(event as NarrativeTerminalEvent);
      }
    });
  });
}
function submit(content = '玩家输入', sessionId = 'session') {
  const finished = terminal(sessionId);
  const accepted = narrative.submit({
    sessionId, input: { text: content }, expectedTipEntryId: services.sessions.require(sessionId).tipEntryId,
  });
  return { accepted, finished };
}

function regenerate(userEntryId: string, assistantEntryId: string | null) {
  const finished = terminal();
  const accepted = narrative.regenerate({sessionId:'session', userEntryId, assistantEntryId,
    expectedTipEntryId: services.sessions.require('session').tipEntryId!});
  return {accepted, finished};
}

describe('regeneration of the latest user round', () => {
  it('deletes before creation, reuses the user and round, and replaces recorded usage', async () => {
    const first = submit(); await first.finished;
    const originalUsage = narrative.usage('session');
    seen.length = 0;
    const next = regenerate(first.accepted.userEntryId, first.accepted.assistantEntryId);
    expect(next.accepted).toMatchObject({runId:first.accepted.runId,userEntryId:first.accepted.userEntryId,
      deletedMessageIds:[first.accepted.assistantEntryId],tipEntryId:first.accepted.userEntryId});
    expect(next.accepted.assistantEntryId).not.toBe(first.accepted.assistantEntryId);
    expect(services.sessions.getEntry('session', first.accepted.assistantEntryId)).toBeNull();
    expect(services.sessions.getNarrativeOutcome(services.sessions.getEntry('session', first.accepted.userEntryId)!)).toBeNull();
    expect(narrative.list('session').items[0]).toMatchObject({status:'running',assistantEntryId:next.accepted.assistantEntryId});
    expect(() => narrative.stop('session',first.accepted.runId,first.accepted.assistantEntryId)).toThrow('RUN_NOT_FOUND');
    expect((await next.finished).event).toBe('run.completed');
    expect(seen.slice(0,2).map(event=>event.event)).toEqual(['message.deleted','run.created']);
    expect(services.sessions.getHistory('session').map(entry=>entry.id)).toEqual([first.accepted.userEntryId,next.accepted.assistantEntryId]);
    expect(narrative.usage('session').knownUsage).toEqual(originalUsage.knownUsage);
    expect(stream.mock.calls[1]![1].filter(message=>message.role==='user').map(message=>message.content)).toEqual(['玩家输入']);
    expect(JSON.stringify(stream.mock.calls[1]![1])).not.toContain('完整正文');
  });

  it('keeps compaction successors and the actual tip while reconnecting their parent', async () => {
    const first = submit(); await first.finished;
    services.sessions.appendEntry('session',{id:'summary',runId:first.accepted.runId,type:'compaction',role:null,payload:{summary:'stale summary'}});
    const next = regenerate(first.accepted.userEntryId,first.accepted.assistantEntryId);
    expect(next.accepted.tipEntryId).toBe('summary');
    expect(services.sessions.getEntry('session','summary')!.parentId).toBe(first.accepted.userEntryId);
    expect((await next.finished).event).toBe('run.completed');
    expect(services.sessions.getEntry('session',next.accepted.assistantEntryId)!.parentId).toBe('summary');
    expect(JSON.stringify(stream.mock.calls[1]![1])).not.toContain('stale summary');
  });

  it('rolls back both deletion and outcome reset if admission fails', async () => {
    const first = submit(); await first.finished;
    const before = services.sessions.getHistory('session');
    vi.spyOn(services.sessions,'setNarrativeOutcome').mockImplementationOnce(()=>{throw Error('storage failure');});
    expect(()=>regenerate(first.accepted.userEntryId,first.accepted.assistantEntryId)).toThrow('storage failure');
    expect(services.sessions.getHistory('session')).toEqual(before);
    expect(narrative.list('session').activeRunId).toBeNull();
    expect((await regenerate(first.accepted.userEntryId,first.accepted.assistantEntryId).finished).event).toBe('run.completed');
  });

  it('keeps deletion on a pre-request stop and can retry the user-only round', async () => {
    const first = submit(); await first.finished;
    const next = regenerate(first.accepted.userEntryId,first.accepted.assistantEntryId);
    narrative.stop('session',next.accepted.runId,next.accepted.assistantEntryId);
    expect((await next.finished).event).toBe('run.stopped');
    expect(services.sessions.getHistory('session').map(entry=>entry.id)).toEqual([first.accepted.userEntryId]);
    const retry = regenerate(first.accepted.userEntryId,null);
    expect(retry.accepted.deletedMessageIds).toEqual([]);
    expect((await retry.finished).event).toBe('run.completed');
    expect(services.sessions.getHistory('session')).toHaveLength(2);
  });

  it('rejects stale, historical, opening and active targets without deleting anything', async () => {
    const first = submit(); await first.finished;
    expect(()=>narrative.regenerate({sessionId:'session',userEntryId:first.accepted.userEntryId,assistantEntryId:first.accepted.assistantEntryId,expectedTipEntryId:first.accepted.userEntryId})).toThrow('TIP_CONFLICT');
    expect(()=>regenerate(first.accepted.assistantEntryId,null)).toThrow('INVALID_REGENERATION_TARGET');
    const second = submit('next');
    expect(()=>regenerate(first.accepted.userEntryId,first.accepted.assistantEntryId)).toThrow('RUN_ALREADY_ACTIVE');
    await second.finished;
    expect(()=>regenerate(first.accepted.userEntryId,first.accepted.assistantEntryId)).toThrow('INVALID_REGENERATION_TARGET');
    expect(()=>regenerate(second.accepted.userEntryId,null)).toThrow('INVALID_REGENERATION_TARGET');
    expect(()=>regenerate(second.accepted.userEntryId,first.accepted.assistantEntryId)).toThrow('INVALID_REGENERATION_TARGET');
    expect(services.sessions.getHistory('session')).toHaveLength(4);
  });

  it('publishes the inherited message state only after deletion commits under the run lock', async () => {
    const user = services.sessions.appendEntry('session',{id:'user',runId:'round',type:'message',role:'user',payload:{message:{role:'user',content:'Go'}},state:[{key:'coins',value:5}]});
    services.sessions.appendEntry('session',{id:'old-ai',runId:'round',type:'message',role:'assistant',payload:{message:{role:'assistant',content:'Old'}},state:[{key:'coins',value:3}]});
    const changes: unknown[] = [], observations: Array<{deleted:boolean;locked:boolean}> = [];
    events.subscribe('session',event=>{
      if(event.event!=='state.changed')return;
      changes.push(event.data);
      let locked=false;try { services.sessions.update('session',{title:'blocked'}); } catch(error) { locked=error instanceof Error && error.message.includes('SESSION_WRITE_LOCKED'); }
      observations.push({deleted:services.sessions.getEntry('session','old-ai')===null,locked});
    });
    await regenerate(user.id,'old-ai').finished;
    expect(changes).toContainEqual({scope:'message',path:'',value:{coins:5}});
    expect(observations).toEqual([{deleted:true,locked:true}]);
  });
});

it.each(['', 'Partial new answer'])('keeps the deletion after provider failure with output %j', async content => {
  const first=submit();await first.finished;
  stream.mockImplementation(async function* () {
    yield {type:'request_started'};
    yield {type:'error',snapshot:snapshot(content),stopReason:'provider_error',usage};
  });
  const next=regenerate(first.accepted.userEntryId,first.accepted.assistantEntryId);
  expect(await next.finished).toMatchObject({event:'run.stopped',data:{assistantEntryId:next.accepted.assistantEntryId,stop_reason:'provider_error'}});
  expect(services.sessions.getEntry('session',first.accepted.assistantEntryId)).toBeNull();
  const entries=services.sessions.getHistory('session');
  expect(entries.filter(entry=>entry.role==='user').map(entry=>entry.id)).toEqual([first.accepted.userEntryId]);
  expect(entries.filter(entry=>entry.role==='assistant').map(entry=>entry.id)).toEqual(content?[next.accepted.assistantEntryId]:[]);
});
