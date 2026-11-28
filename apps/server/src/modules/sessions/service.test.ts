import { seedMessage } from '../../testing/run-fixtures.js';
import { worldPublication } from '../../testing/fixtures.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { createServices, type Services } from '../../services.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { type SessionService, type UpdateSessionInput } from './service.js';

let db: DatabaseSync, services: Services, sessions: SessionService, dataRoot: string;
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-session-service-'));
  services = createServices(db, dataRoot);
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'actual-model', credentialRef: 'credential-ref' });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({ id: 'world', specVersion: '0.2', publication: worldPublication(), name: 'World', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });
  sessions = services.sessions;
});
afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function create(id = 'session') {
  return sessions.create({ id, worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player' });
}
describe('session records and references', () => {
  it('starts with no tip and changes only the session-owned fields', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const created = create();
    expect(created).toMatchObject({ tipEntryId: null, state: {}, createdAt: 100, updatedAt: 100 });
    expect(Object.keys(created).sort()).toEqual([
      'createdAt', 'id', 'runtimeConfig', 'state', 'tipEntryId', 'title', 'updatedAt', 'userCharacterId', 'worldId',
    ]);
    sessions.setState(created.id, { coins: 7 });
    vi.mocked(Date.now).mockReturnValue(200);
    expect(sessions.update(created.id, { title: 'Renamed' })).toMatchObject({
      title: 'Renamed', state: { coins: 7 }, createdAt: 100, updatedAt: 200,
    });
    expect(() => sessions.update(created.id, { state: {} } as unknown as UpdateSessionInput)).toThrow();
    expect(sessions.get('missing')).toBeNull();
  });

  it('validates the selected player and keeps identity fixed after creation', () => {
    expect(() => sessions.create({ worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'npc' })).toThrow('INVALID_SESSION_CHARACTER');
    expect(sessions.list()).toEqual([]);
    const created = create();
    expect(() => sessions.update(created.id, { userCharacterId: 'npc' } as never)).toThrow();
    expect(sessions.require(created.id).userCharacterId).toBe('player');
  });

  it('rejects missing world/model/preset references atomically', () => {
    const input = { id: 'bad', worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player' };
    expect(() => sessions.create({ ...input, worldId: 'missing' })).toThrow('WORLD_NOT_FOUND');
    expect(() => sessions.create({ ...input, runtimeConfig: { ...input.runtimeConfig, apiModelConfigId: 'missing' } })).toThrow('MODEL_CONFIG_NOT_FOUND');
    expect(() => sessions.create({ ...input, runtimeConfig: { ...input.runtimeConfig, narrativePresetId: 'missing' } })).toThrow('PRESET_NOT_FOUND');
    expect(sessions.list()).toHaveLength(0);
    create();
    expect(() => sessions.update('session', { title: 'must rollback', runtimeConfig: { narrativePresetId: 'missing' } })).toThrow('PRESET_NOT_FOUND');
    expect(sessions.get('session')!.title).toBeNull();
  });

  it('counts requested worlds in one service operation, including zero counts', () => {
    services.worlds.create({ id: 'other', specVersion: '0.2', publication: worldPublication(), name: 'Other', characters: [{ id: 'player', name: 'Player', player_selectable: true }], openings: [{ id: 'start', name: 'Start', content: 'Begin' }] });
    create('one'); create('two');
    sessions.create({ id: 'three', worldId: 'other', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player' });
    expect(sessions.countByWorldIds(['world', 'other', 'missing', 'world'])).toEqual({ world: 2, other: 1, missing: 0 });
    expect(sessions.countByWorldIds(['other'])).toEqual({ other: 1 });
    expect(sessions.countByWorldIds([])).toEqual({});
    sessions.delete('one');
    expect(sessions.countByWorldIds(['world'])).toEqual({ world: 1 });
    expect(() => sessions.countByWorldIds([' world'])).toThrow();
  });

  it('lists by a stable updated-at/id cursor and cascades entries on deletion', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    create('a'); create('b'); create('c');
    const first = sessions.list({ worldId: 'world', limit: 2 });
    expect(first.map(value => value.id)).toEqual(['c', 'b']);
    expect(sessions.listPage({ worldId: 'world', limit: 2 })).toEqual({ items: first, hasMore: true });
    expect(sessions.listPage({ before: { updatedAt: 100, id: 'b' }, limit: 2 }).hasMore).toBe(false);
    expect(sessions.list({ before: { updatedAt: 100, id: 'b' } }).map(value => value.id)).toEqual(['a']);
    seedMessage(services, 'a', { id:'entry', runId:'opening', type:'message', role:'assistant', payload:{message:{role:'assistant',content:'Hello',timestamp:1}} });
    await expect(services.worlds.delete('world')).rejects.toThrow();
    expect(sessions.delete('a')).toBe(true);
    expect(sessions.getEntry('a', 'entry')).toBeNull();
    expect(sessions.delete('a')).toBe(false);
  });
});


describe('run metrics, integrity and settlement', () => {
  const body = (id:string, role:'assistant'|'user', parentId:string|null) => ({
    id, parentId, timestamp:1, payload:{message:{role,content:id,timestamp:1}},
  });
  function begin(runId: string) {
    const permit = services.cache.acquireRun({sessionId:'session',worldId:'world',runId});
    const assistantId = runId+'-a', user = body(runId+'-u','user',sessions.require('session').tipEntryId);
    sessions.beginRun('session',runId,assistantId,user,permit);
    return {permit,assistantId,user};
  }
  const main = {
    requests:[{requestId:'q',modelId:'actual-model',provider:'provider',usage:null}],
    context:{requestId:'q',apiModelConfigId:'model',contextWindowTokens:8192,contextComposition:{systemBytes:12,historyBytes:23,summaryBytes:0}},
  };
  it('checks both permit and execution identity, rolls back invalid messages and metrics, and releases without orphaning entries', () => {
    create();
    const {permit,user,assistantId} = begin('r');
    const answer = body(assistantId,'assistant',user.id);
    expect(() => sessions.settleRun('session','foreign',assistantId,null,answer,null,main,permit)).toThrow('SESSION_WRITE_LOCKED');
    expect(() => sessions.settleRun('session','r','stale',null,answer,null,main,permit)).toThrow('RUN_NOT_FOUND');
    expect(() => sessions.settleRun('session','r',assistantId,null,{...answer,parentId:null},null,main,permit)).toThrow('TIP_CONFLICT');
    expect(() => sessions.settleRun('session','r',assistantId,null,body(assistantId,'user',user.id),null,main,permit)).toThrow();
    expect(() => sessions.settleRun('session','r',assistantId,null,answer,null,
      {...main,context:{...main.context,requestId:'unowned'}},permit)).toThrow('INVALID_REQUEST_METRICS');
    expect(sessions.getHistory('session').map(e=>e.id)).toEqual([user.id]);
    expect(sessions.getRun('session','r')).toMatchObject({status:'running',usage:{recordedRequestCount:0}});
    const injected = {...answer,extData:{output:{forged:true}}};
    sessions.settleRun('session','r',assistantId,null,injected,null,main,permit);
    services.cache.releaseRun(permit);
    expect(sessions.getEntry('session',assistantId)).toMatchObject({extData:{},status:'complete',seq:2});
    const next = begin('r2');
    expect(() => sessions.settleRun('session','r2',next.assistantId,'cancelled',null,null,main,next.permit)).toThrow('DUPLICATE_REQUEST_METRICS');
    sessions.settleRun('session','r2',next.assistantId,'cancelled',null,null,null,next.permit);
    services.cache.releaseRun(next.permit);
  });

  it('preserves summary metrics through regeneration, replaces the main request and marks stale contexts', () => {
    create();
    const {permit,user,assistantId} = begin('r');
    sessions.appendSummary('session',{id:'c',parentId:user.id,runId:'r',text:'summary',coveredThroughEntryId:user.id,
      sourceHash:'0'.repeat(64),metrics:{requests:[{...main.requests[0]!,requestId:'summary-call'}]}},permit);
    sessions.settleRun('session','r',assistantId,null,body(assistantId,'assistant','c'),null,main,permit);
    services.cache.releaseRun(permit);
    expect(sessions.recordedUsage('session')).toMatchObject({recordedRequestCount:2,unknownUsageRequestCount:2,
      latestContext:{stale:false,modelId:'actual-model',inputTokens:null,contextWindowTokens:8192}});
    services.models.update('model',{modelId:'renamed'});
    expect(sessions.recordedUsage('session').latestContext?.stale).toBe(true);
    const retry = services.cache.acquireRun({sessionId:'session',worldId:'world',runId:'r'});
    sessions.restartRun('session','r',assistantId,'new-ai',assistantId,retry);
    expect(sessions.recordedUsage('session')).toMatchObject({recordedRequestCount:1,latestContext:null});
    expect(() => sessions.settleRun('session','r',assistantId,'cancelled',null,null,null,retry)).toThrow('RUN_NOT_FOUND');
    sessions.settleRun('session','r','new-ai','provider_error',null,null,main,retry);
    services.cache.releaseRun(retry);
    expect(sessions.recordedUsage('session')).toMatchObject({recordedRequestCount:2,unknownUsageRequestCount:2,latestContext:null});
    expect(sessions.getEntry('session','c')).toMatchObject({status:null});
    expect(sessions.getRun('session','r')).toMatchObject({messages:[{id:user.id}],capabilities:{}});
  });
});
