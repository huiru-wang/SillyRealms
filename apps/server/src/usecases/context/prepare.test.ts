import { worldPublication } from '../../testing/fixtures.js';
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
import { narrativePreset, withEmptyModelNotes } from '../../testing/fixtures.js';
import { prepareContext, type ContextDependencies, type ContextProgress, type PrepareContextInput } from './index.js';

const model: ModelInfo = {
  providerId: 'provider', modelId: 'model', name: 'Model', contextWindow: 64000, maxTokens: 8192,
  api: 'test', input: ['text'], reasoning: false, thinkingLevels: ['off'], thinkingLevelMap: null,
  promptCache: null, supportsMidConversationSystemMessages: true,
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
  preset.config.nodes.find(node => node.id === 'personaInfo')!.prompt = '{{persona.content}}';
  services.presets.create({ ...preset, id: 'preset' });
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'original-reference' });
  services.worlds.create({
    id: 'world', name: 'World', specVersion: '0.2', publication: worldPublication(),
    characters: [{ id: 'player', name: 'Player', player_selectable: true, content: 'Original persona' }],
    openings: [{ id: 'start', name: 'Start', content: 'Opening' }],
  });
  services.sessions.create({ id: 'session', worldId: 'world', runtimeConfig: { narrativePresetId: 'preset', apiModelConfigId: 'model' }, userCharacterId: 'player' });
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
  services.sessions.appendEntry('session', {
    id: 'current', runId: 'current-run', type: 'message', role: 'user',
    payload: { message: { role: 'user', content: 'Current input', timestamp: 2 } },
  });
  return { sessionId: 'session', signal: new AbortController().signal,
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
  it.each([['en', 'English'], ['ja', '日本語']] as const)('captures %s before waiting and retains it through summary and candidate rebuilds', async (locale, language) => {
    seedCompaction();
    const preset = services.presets.require('preset');
    preset.config.nodes.find(node => node.id === 'main')!.prompt = 'Reply in {{system.language}}.';
    services.presets.update('preset', { config: preset.config });
    services.settings.ensure({ locale, defaultPresetId: null, defaultApiModelConfigId: null });

    const request = input();
    const pending = prepareContext(dependencies, request);
    services.settings.update({ locale: 'zh-CN' });
    const prepared = await pending;
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.failure.code);
    expect(summarize).toHaveBeenCalledOnce();
    expect(prepared.request.messages[0]?.content).toBe('Reply in ' + language + '.');
    expect(prepared.request.messages.map(message => message.content).join('\n')).not.toContain('{{system.language}}');

    const next = await prepareContext(dependencies, request);
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error(next.failure.code);
    expect(next.request.messages[0]?.content).toBe('Reply in 简体中文.');
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('renders author conditions from one captured state and switches on the next preparation only', async () => {
    const content = "{% if getState('affinity', {scope: 'message'}) >= 60 %}Trusted {{user}}/{{state.message.affinity}}{% else %}Guarded {{user}}/{{state.message.affinity}}{% endif %}";
    services.worlds.update('world', {
      characters: [{ id: 'player', name: 'Player', player_selectable: true, content }],
      stateDefinition: { schema_version: 2, scopes: { message: {
        affinity: { type: 'number', initial: 0, description: 'Affinity', min: 0, max: 100 },
      } } },
    });
    const history = '{% if false %}historical literal{% endif %}';
    appendHistory('old', history);
    const request = input();
    services.sessions.setEntryState('session', 'current', [{ key: 'affinity', value: 70 }]);
    const pending = prepareContext(dependencies, request);
    services.sessions.setEntryState('session', 'current', [{ key: 'affinity', value: 40 }]);

    const first = await pending;
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.failure.code);
    const contents = first.request.messages.map(message => message.content);
    expect(contents).toContain('Trusted Player/70');
    expect(contents.join('\n')).toContain(history);
    expect(contents.join('\n')).not.toContain('Guarded Player/40');

    const second = await prepareContext(dependencies, request);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.failure.code);
    expect(second.request.messages.map(message => message.content)).toContain('Guarded Player/40');
    expect(services.worlds.require('world').characters[0]).toMatchObject({ content });
    expect(summarize).not.toHaveBeenCalled();
  });

  it('retains author condition source diagnostics and does not prepare a model request after a failure', async () => {
    const content = "Role\n{% if getState('missing', {scope: 'message'}) > 0 %}yes{% else %}wrong fallback{% endif %}";
    services.worlds.update('world', {
      characters: [{ id: 'player', name: 'Player', player_selectable: true, content }],
    });
    const prepared = await prepareContext(dependencies, input());
    expect(prepared).toMatchObject({ ok: false, parentEntryId: 'current', failure: { code: 'INVALID_NARRATIVE_TEMPLATE' } });
    if (prepared.ok) throw new Error('Expected author template failure');
    expect(prepared.failure.detail).toContain('characters[0].content (id: "player")');
    expect(prepared.failure.detail).toMatch(/line 2|第 2 行/);
    expect(prepared.failure.detail).not.toContain('wrong fallback');
    expect(dependencies.modelClient.resolve).toHaveBeenCalledExactlyOnceWith('provider', 'model');
    expect(summarize).not.toHaveBeenCalled();
    expect(services.sessions.getHistory('session')).toHaveLength(1);
    expect(services.worlds.require('world').characters[0]).toMatchObject({ content });
  });

  it.each([
    ['persona.content', 'personaInfo', 'characters[0].content'],
    ['characters.content', 'characterInfo', 'characters[1].content'],
    ['world.lore', 'worldInfo', 'lorebook.entries[0].content'],
  ] as const)('evaluates %s only when an enabled preset node actually references it', async (variable, builtinId, path) => {
    const source = "Role\n{% if getState('missing', {scope: 'message'}) > 0 %}unreachable facts{% endif %}";
    services.worlds.update('world', {
      characters: [
        { id: 'player', name: 'Player', player_selectable: true, content: variable === 'persona.content' ? source : 'Player facts' },
        { id: 'alice', name: 'Alice', content: variable === 'characters.content' ? source : 'Alice facts' },
      ],
      lorebook: { entries: [{ id: 'facts', content: variable === 'world.lore' ? source : 'World facts' }] },
    });
    const preset = services.presets.require('preset');
    // Narrative system nodes stay enabled; removing their variable reference is supported.
    preset.config.nodes.find(node => node.id === builtinId)!.prompt = 'No author material in this node.';
    preset.config.nodes.push({ id: 'optionalAuthorMaterial', name: 'Optional author material',
      kind: 'text', role: 'system', enabled: false, prompt: 'Custom {{' + variable + '}}' });
    services.presets.update('preset', { config: preset.config });
    const request = input();

    const unused = await prepareContext(dependencies, request);
    expect(unused.ok).toBe(true);
    if (!unused.ok) throw new Error(unused.failure.code);
    expect(unused.request.messages.map(message => message.content).join('\n')).not.toContain('unreachable facts');

    preset.config.nodes.find(node => node.id === 'optionalAuthorMaterial')!.enabled = true;
    services.presets.update('preset', { config: preset.config });
    const consumed = await prepareContext(dependencies, request);
    expect(consumed).toMatchObject({ ok: false, parentEntryId: 'current', failure: { code: 'INVALID_NARRATIVE_TEMPLATE' } });
    if (consumed.ok) throw new Error('Expected the custom node to evaluate its author material');
    expect(consumed.failure.detail).toContain(path);
    expect(consumed.failure.detail).toMatch(/line 2|第 2 行/);
    expect(summarize).not.toHaveBeenCalled();
    expect(services.sessions.getHistory('session')).toHaveLength(1);
  });

  it('builds an empty session without saving a user or inventing an input turn', async () => {
    const preset = services.presets.require('preset');
    preset.config.nodes.find(node => node.id === 'userInput')!.prompt = 'User says: {{input.text}}';
    services.presets.update('preset', { config: preset.config });
    const prepared = await prepareContext(dependencies, { sessionId: 'session', signal: new AbortController().signal });
    expect(prepared).toMatchObject({ ok: true, parentEntryId: null });
    if (!prepared.ok) throw new Error(prepared.failure.code);
    expect(prepared.request.messages.filter(message => message.role === 'user')).toEqual([]);
    expect(prepared.diagnostics.nodes.find(node => node.id === 'userInput')).toMatchObject({ included: false });
    expect(services.sessions.getHistory('session')).toEqual([]);
    expect(summarize).not.toHaveBeenCalled();
  });

  it.each(['Answer', ''])('keeps an answered user before the latest assistant (%j) without replaying the input node', async content => {
    input();
    services.sessions.appendEntry('session', {
      id: 'answer', runId: 'current-run', type: 'message', role: 'assistant',
      payload: { message: { role: 'assistant', content, reasoning_content: 'Hidden reasoning', timestamp: 3 } },
    });
    const preset = services.presets.require('preset');
    preset.config.nodes.find(node => node.id === 'userInput')!.prompt = 'User says: {{input.text}}';
    services.presets.update('preset', { config: preset.config });
    const prepared = await prepareContext(dependencies, { sessionId: 'session', signal: new AbortController().signal });
    expect(prepared).toMatchObject({ ok: true, parentEntryId: 'answer' });
    if (!prepared.ok) throw new Error(prepared.failure.code);
    expect(prepared.request.messages.filter(message => message.role !== 'system').map(message => [message.role, message.content]))
      .toEqual([['user', 'Current input'], ...(content ? [['assistant', withEmptyModelNotes(content)]] : [])]);
    expect(prepared.diagnostics.nodes.find(node => node.id === 'userInput')).toMatchObject({ included: false });
    expect(services.sessions.getHistory('session')).toHaveLength(2);
  });

  it('reads effective state at the actual tip, including a user state followed by compaction', async () => {
    const request = input();
    services.sessions.setEntryState('session', 'current', [{ key: 'coins', value: 12 }]);
    services.sessions.appendEntry('session', {
      id: 'trailing-summary', runId: 'current-run', type: 'compaction', role: null,
      payload: { summary: 'Unverified summary must not hide history' },
    });
    const views = vi.spyOn(services.state, 'getViews');
    const prepared = await prepareContext(dependencies, request);
    expect(prepared).toMatchObject({ ok: true, parentEntryId: 'trailing-summary' });
    expect(views).toHaveBeenCalledWith({ sessionId: 'session', worldId: 'world', entryId: 'trailing-summary' });
    expect(views.mock.results[0]!.value.message).toEqual({ coins: 12 });
    if (!prepared.ok) throw new Error(prepared.failure.code);
    expect(prepared.request.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['Current input']);
    expect(prepared.request.messages.some(message => message.content.includes('Unverified summary'))).toBe(false);
  });

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
    world.characters = [{ id: 'player', name: 'Player', player_selectable: true, content: 'Changed persona' }];
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
    expect(prepared.request).toMatchObject({ credentialRef: 'original-reference', modelParameters: { temperature: 1 } });
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
    expect(services.sessions.getEntry('session', prepared.summary!.entryId)).toMatchObject({
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

  it('reuses a trailing committed summary on repeated builds without another user or summary write', async () => {
    seedCompaction();
    const request = input();
    const first = await prepareContext(dependencies, request);
    expect(first.ok).toBe(true);
    expect(first.summary).toBeDefined();
    const entries = services.sessions.getHistory('session');
    const second = await prepareContext(dependencies, request);
    expect(second).toMatchObject({ ok: true, parentEntryId: first.parentEntryId });
    expect(second.summary).toBeUndefined();
    if (!second.ok) throw new Error(second.failure.code);
    const text = second.request.messages.map(message => message.content).join('\n');
    expect(text.match(/Current input/g)).toHaveLength(1);
    expect(text.match(/Short summary/g)).toHaveLength(1);
    expect(text).not.toContain('Old story');
    expect(summarize).toHaveBeenCalledOnce();
    expect(services.sessions.getHistory('session')).toEqual(entries);
  });

  it('appends optimization summaries to the actual tip and derives their run from stored history', async () => {
    seedCompaction();
    const prepared = await prepareContext(dependencies, { sessionId: 'session', signal: new AbortController().signal });
    expect(prepared.ok).toBe(true);
    expect(prepared.summary).toBeDefined();
    expect(services.sessions.getEntry('session', prepared.summary!.entryId)).toMatchObject({
      parentId: 'old-7', runId: 'old-7-run', type: 'compaction',
    });
    if (!prepared.ok) throw new Error(prepared.failure.code);
    expect(prepared.request.messages.filter(message => message.role === 'user')).toEqual([]);
    expect(prepared.request.messages.filter(message => message.role === 'assistant').map(message => message.content))
      .toEqual(['Recent 3', 'Recent 4', 'Recent 5', withEmptyModelNotes('Recent 6'), withEmptyModelNotes('Recent 7')]);
  });

  it('saves a new summary after an existing trailing compaction instead of trying to append to the user', async () => {
    seedCompaction();
    const request = input();
    services.sessions.appendEntry('session', {
      id: 'unverified-summary', runId: 'current-run', type: 'compaction', role: null, payload: { summary: 'Unverified' },
    });
    const prepared = await prepareContext(dependencies, request);
    expect(prepared.ok).toBe(true);
    expect(prepared.summary).toBeDefined();
    expect(services.sessions.getEntry('session', prepared.summary!.entryId)).toMatchObject({
      parentId: 'unverified-summary', runId: 'current-run', type: 'compaction',
    });
  });

  it.each(['tip', 'body'])('rejects a stale summary when the %s changes during the model await', async change => {
    seedCompaction();
    const request = input();
    summarize.mockImplementationOnce(async () => {
      if (change === 'tip') appendHistory('new-tail', 'New tail');
      else services.sessions.updateEntry('session', 'old-0', {
        payload: { message: { role: 'assistant', content: 'Edited during summary', timestamp: 1 } },
      });
      return { ok: true, text: 'Obsolete summary', metrics };
    });
    const prepared = await prepareContext(dependencies, request);
    expect(prepared).toMatchObject({ ok: false, failure: { code: 'TIP_CONFLICT' } });
    expect(prepared.summary).toBeUndefined();
    expect(services.sessions.getHistory('session').filter(entry => entry.type === 'compaction')).toEqual([]);
    expect(services.sessions.require('session').tipEntryId).toBe(change === 'tip' ? 'new-tail' : 'current');
  });
});

describe('captured character sprite catalog', () => {
  it.each([true, false])('retains the synchronous catalog across async preparation when enabled=%s', enabled => {
    services.worlds.update('world', { characters: [
      { id: 'player', name: 'Player', player_selectable: true, content: 'Original persona',
        sprites: [{ id: 'default', description: 'captured-description', asset: 'https://example.com/original.png' }] },
    ] });
    const config = services.presets.require('preset').config;
    config.nodes.find(node => node.id === 'characterSprite')!.enabled = enabled;
    services.presets.update('preset', { config });
    const pending = prepareContext(dependencies, input());
    services.worlds.update('world', { characters: [
      { id: 'player', name: 'Player', player_selectable: true, content: 'Original persona',
        sprites: [{ id: 'default', description: 'later-description', asset: 'https://example.com/later.png' }] },
    ] });
    return pending.then(prepared => {
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error(prepared.failure.code);
      expect(prepared.request.characterSpriteCatalog).toEqual([{
        characterId: 'player', characterName: 'Player', spriteId: 'default',
        description: 'captured-description', asset: 'https://example.com/original.png',
      }]);
      const messages = prepared.request.messages.map(message => message.content).join('\n');
      expect(messages.includes('captured-description')).toBe(enabled);
      expect(messages).not.toContain('later-description');
      expect(messages).not.toContain('https://example.com/original.png');
    });
  });
});
