import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../infrastructure/database/connection.js';
import type { ModelInfo } from '../../infrastructure/model/client.js';
import type { EntryMetrics } from '../../modules/sessions/service.js';
import { createServices, type Services } from '../../services.js';
import { memoryCredentials } from '../../testing/credentials.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { prepareContext, type ContextDependencies, type ContextProgress, type PrepareContextInput } from './index.js';

const model: ModelInfo = {
  providerId: 'provider', modelId: 'model', name: 'Model', contextWindow: 64000, maxTokens: 8192,
  api: 'test', input: ['text'], reasoning: false, thinkingLevels: ['off'], thinkingLevelMap: null,
  promptCache: null, narrativeCompatible: true, supportsMidConversationSystemMessages: true,
};
const metrics: EntryMetrics = { requests: [{
  requestId: 'summary-request', provider: 'provider', modelId: 'model',
  usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 },
}] };
let db: DatabaseSync, dataRoot: string, services: Services, dependencies: ContextDependencies;
let summarize: ReturnType<typeof vi.fn<ContextDependencies['summarize']>>;

beforeEach(() => {
  db = openDatabase(':memory:'); dataRoot = mkdtempSync(join(tmpdir(), 'sr-context-api-'));
  services = createServices(db, dataRoot, memoryCredentials());
  const preset = narrativePreset();
  preset.config.nodes.find(node => node.id === 'personaInfo')!.prompt = '{{persona.prompt}}';
  services.presets.create({ ...preset, id: 'preset' });
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'original-reference' });
  services.worlds.create({
    id: 'world', name: 'World', specVersion: '0.1',
    characters: [{ id: 'player', name: 'Player', player_selectable: true, prompt: 'Original persona' }],
    openings: [{ id: 'start', name: 'Start', content: 'Opening' }],
  });
  services.sessions.create({ id: 'session', worldId: 'world', presetId: 'preset', apiModelConfigId: 'model', userCharacterId: 'player' });
  summarize = vi.fn<ContextDependencies['summarize']>(async request => {
    request.onStarted();
    return { ok: true, text: 'Short summary', metrics };
  });
  dependencies = { ...services, modelClient: { resolve: vi.fn(() => model), assertMessageOrder: vi.fn() }, summarize };
});
afterEach(() => {
  vi.restoreAllMocks(); db.close(); rmSync(dataRoot, { recursive: true, force: true });
});
function appendHistory(id: string, content: string) {
  return services.sessions.appendEntry('session', {
    id, runId: id + '-run', type: 'message', role: 'assistant',
    payload: { message: { role: 'assistant', content, timestamp: 1 } },
  });
}
function input(onProgress?: (progress: ContextProgress) => void): PrepareContextInput {
  const previousTipEntryId = services.sessions.require('session').tipEntryId;
  const user = services.sessions.appendEntry('session', {
    id: 'current', runId: 'current-run', type: 'message', role: 'user',
    payload: { message: { role: 'user', content: 'Current input', timestamp: 2 } },
  });
  return { kind: 'narrative', sessionId: 'session', runId: user.runId, userEntryId: user.id,
    previousTipEntryId, inputText: 'Current input', signal: new AbortController().signal,
    ...(onProgress ? { onProgress } : {}),
  };
}
function seedCompaction() {
  const preset = services.presets.require('preset');
  preset.config.contextStrategy.maxContextTokens = 1500;
  services.presets.update('preset', { config: preset.config });
  for (let index = 0; index < 8; index++) {
    appendHistory('old-' + index, index < 3 ? 'Old story ' + 'x'.repeat(7000) : 'Recent ' + index);
  }
}

describe('public context preparation', () => {
  it('captures sources synchronously before the first await and keeps that frozen view', async () => {
    appendHistory('old', 'Original history');
    const request = input();
    const world = services.worlds.require('world'), preset = services.presets.require('preset');
    const configuredModel = services.models.require('model');
    const readWorld = vi.spyOn(services.worlds, 'require').mockReturnValue(world);
    vi.spyOn(services.presets, 'require').mockReturnValue(preset);
    vi.spyOn(services.models, 'require').mockReturnValue(configuredModel);

    const pending = prepareContext(dependencies, request);
    expect(readWorld).toHaveBeenCalledWith('world');
    expect(dependencies.modelClient.resolve).not.toHaveBeenCalled();
    world.characters = [{ id: 'player', name: 'Player', player_selectable: true, prompt: 'Changed persona' }];
    preset.config.modelParameters.temperature = 0.2;
    configuredModel.providerId = 'changed-provider';
    configuredModel.credentialRef = 'changed-reference';
    services.sessions.updateEntry('session', 'old', {
      payload: { message: { role: 'assistant', content: 'Changed history', timestamp: 1 } },
    });

    const prepared = await pending;
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.failure.code);
    const contents = prepared.request.messages.map(message => message.content).join('\n');
    expect(contents).toContain('Original history');
    expect(contents).toContain('Original persona');
    expect(contents).not.toMatch(/Changed history|Changed persona/);
    expect(prepared.request).toMatchObject({ credentialRef: 'original-reference', temperature: 1 });
    expect(dependencies.modelClient.resolve).toHaveBeenCalledWith('provider', 'model');
    expect(prepared.parentEntryId).toBe('current');
    expect(prepared.summary).toBeUndefined();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('returns the committed summary receipt even when its final context remains over capacity', async () => {
    seedCompaction();
    summarize.mockImplementationOnce(async request => {
      request.onStarted();
      return { ok: true, text: 's'.repeat(9000), metrics };
    });
    const prepared = await prepareContext(dependencies, input());
    expect(prepared).toMatchObject({ ok: false, failure: { code: 'SUMMARY_CAPACITY_EXCEEDED' },
      summary: { entryId: expect.any(String), metrics } });
    const summaries = services.sessions.getHistory('session').filter(entry => entry.type === 'compaction');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      parentId: 'current', runId: 'current-run', state: null, metrics,
      payload: { summary: 's'.repeat(9000) },
      extData: { summary: { coveredThroughEntryId: 'old-2', sourceHash: expect.any(String) } },
    });
    expect(prepared.parentEntryId).toBe(summaries[0]!.id);
    expect(prepared.summary?.entryId).toBe(summaries[0]!.id);
    expect(services.sessions.require('session').tipEntryId).toBe(summaries[0]!.id);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('isolates throwing progress observers and reports only the saved summary receipt', async () => {
    seedCompaction();
    const progress: ContextProgress[] = [];
    let savedWhenNotified = false;
    const prepared = await prepareContext(dependencies, input(event => {
      progress.push(event);
      if (event.type === 'summary_saved') {
        savedWhenNotified = services.sessions.getEntry('session', event.entryId)?.payload.summary === 'Short summary';
      }
      throw new Error('progress listener failed');
    }));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.failure.code);
    expect(progress).toEqual([
      { type: 'summary_started' },
      { type: 'summary_saved', entryId: prepared.summary!.entryId },
    ]);
    expect(savedWhenNotified).toBe(true);
    expect(prepared.summary).toEqual({ entryId: prepared.parentEntryId, metrics });
    expect(services.sessions.getEntry('session', prepared.parentEntryId)).toMatchObject({
      type: 'compaction', parentId: 'current', metrics, payload: { summary: 'Short summary' },
    });
    expect(prepared.request.messages.some(message => message.content === 'Short summary')).toBe(true);
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('returns only final-candidate diagnostics after compaction and keeps them outside the model request', async () => {
    seedCompaction();
    services.worlds.update('world', { lorebook: { entries: [
      { id: 'old-topic', title: 'Old topic', content: 'PRIVATE_LORE_CONTENT', load: { mode: 'on_mention', keywords: ['Old story'] } },
    ] } });
    const prepared = await prepareContext(dependencies, input());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.failure.code);
    expect(summarize).toHaveBeenCalledOnce();
    expect(prepared.diagnostics.lore).toMatchObject([
      { id: 'old-topic', name: 'Old topic', matched: false, reason: 'keyword_unmatched',
        keywordMatch: { matchedKeywords: [], excludedKeywords: [], result: false } },
    ]);
    expect(prepared.diagnostics.messageCount).toBe(prepared.request.messages.length);
    expect(prepared.diagnostics.estimatedInputTokens).toBe(prepared.request.estimatedInputTokens);
    expect(prepared.request).not.toHaveProperty('diagnostics');
    expect(JSON.stringify(prepared.diagnostics)).not.toMatch(/PRIVATE_LORE_CONTENT|Original persona|Current input|Short summary/);
  });

});
