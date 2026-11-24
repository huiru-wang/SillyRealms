import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../errors.js';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { createServices, type Services } from '../../services.js';
import { narrativePreset, withEmptyModelNotes } from '../../testing/fixtures.js';
import { planContext as planHistoryContext } from './stages/compact/plan.js';
import { historyBoundaries } from './stages/history/index.js';
import { readSummary, sourceHash } from './stages/compact/saved-summary.js';
import { summaryNarrative, summaryRequest } from './stages/compact/summary-request.js';
import { compactHistory as compactCandidateHistory, type Summarize } from './stages/compact/index.js';
import { createCandidateEvaluator } from './candidate.js';
import { captureContext, type ContextSnapshot } from './capture.js';
import { compileNarrativeContext } from './stages/assemble/index.js';
import * as assembly from './stages/assemble/index.js';
import { estimateInputTokens } from './lib/estimate.js';
import { parsePromptTemplate } from '../../lib/prompt-template.js';
import { systemVariableNames } from '../../modules/presets/service.js';

let db: DatabaseSync, services: Services, dataRoot: string;
const model = { contextWindow: 64000, maxTokens: 8192 };
beforeEach(() => {
  db = openDatabase(':memory:');
  dataRoot = mkdtempSync(join(tmpdir(), 'sr-narrative-context-'));
  services = createServices(db, dataRoot);
  services.models.create({ id: 'model', name: 'Model', providerId: 'provider', modelId: 'model', credentialRef: 'ref' });
  services.presets.create({ ...narrativePreset(), id: 'preset' });
  services.worlds.create({
    id: 'world', specVersion: '0.1', name: 'World',
    characters: [{ id: 'player', name: 'Player', player_selectable: true, prompt: 'Player prompt' }],
    openings: [{ id: 'start', name: 'Start', content: 'Opening stays unused' }], state: { day: 2 },
  });
  services.sessions.create({
    id: 'session', worldId: 'world', presetId: 'preset', apiModelConfigId: 'model',
    userCharacterId: 'player', state: { reputation: 3 },
  });
});
afterEach(() => { db.close(); rmSync(dataRoot, { recursive: true, force: true }); });

function append(id: string, role: 'user' | 'assistant', content: string) {
  return services.sessions.appendEntry('session', {
    id, runId: 'run-' + id, type: 'message', role,
    payload: { message: { role, content, timestamp: 100 } },
  });
}
function capture(inputText = 'Current input') {
  append('current-user', 'user', inputText);
  return captureContext(services, 'session');
}

function planContext(snapshot: ContextSnapshot, selectedModel: typeof model, state: Pick<Services['state'], 'evaluateWhen'>) {
  return planHistoryContext({
    historyEntries: snapshot.historyEntries, contextStrategy: snapshot.preset.config.contextStrategy,
  }, selectedModel, createCandidateEvaluator(snapshot, selectedModel, state));
}
function compactHistory(snapshot: ContextSnapshot, selectedModel: typeof model,
  state: Pick<Services['state'], 'evaluateWhen'>, summarize: Summarize, signal: AbortSignal) {
  return compactCandidateHistory({
    historyEntries: snapshot.historyEntries, contextStrategy: snapshot.preset.config.contextStrategy,
  }, selectedModel, createCandidateEvaluator(snapshot, selectedModel, state), summarize, signal);
}

describe('compiled context composition', () => {
  it.each([['zh-CN', '简体中文'], ['en', 'English'], ['ja', '日本語']] as const)('keeps %s for every history candidate and expands it only in preset source text', (locale, language) => {
    services.settings.ensure({ locale, defaultPresetId: null, defaultApiModelConfigId: null });
    services.worlds.update('world', {
      characters: [{ id: 'player', name: 'Player', player_selectable: true, prompt: 'Author {{system.language}}' }],
    });
    append('prior', 'assistant', 'Earlier reply');
    const snapshot = capture('Input {{system.language}}');
    snapshot.preset.config.nodes.find(node => node.id === 'main')!.prompt = 'Language={{system.language}}';
    snapshot.preset.config.nodes.find(node => node.id === 'personaInfo')!.prompt = '{{persona.prompt}}';
    services.settings.update({ locale: 'zh-CN' });

    const evaluate = createCandidateEvaluator(snapshot, model, services.state);
    for (const entries of [snapshot.historyEntries, snapshot.historyEntries.slice(1)]) {
      const compiled = evaluate(entries, '');
      expect(compiled.messages[0]?.content).toBe('Language=' + language);
      expect(compiled.messages.map(message => message.content)).toContain('Author {{system.language}}');
      expect(compiled.messages.map(message => message.content)).toContain('Input {{system.language}}');
    }
    expect(captureContext(services, 'session').locale).toBe('zh-CN');
  });

  it('rechecks visible roots for every candidate without rescanning material or rereading inherited state', () => {
    const token = '{{state.message.coins}}';
    services.worlds.update('world', {
      characters: [{ id: 'player', name: 'Player', player_selectable: true, prompt: '角色=' + token }],
      stateDefinition: { schema_version: 2, scopes: { message: {
        coins: { type: 'string', initial: '', description: 'Coins', rules: { coins: 'Coins' },
          load: { mode: 'on_mention', keywords: ['gate'] } },
      } } },
    });
    append('prior', 'assistant', 'gate');
    const value = '{{user}}' + '金'.repeat(2048);
    services.sessions.setEntryState('session', 'prior', [{ key: 'coins', value }]);
    const snapshot = capture(token);
    snapshot.preset.config.nodes[0]!.prompt = '{{persona.prompt}}；预设=' + token;
    snapshot.preset.config.nodes.find(node => node.id === 'actionSuggestions')!.prompt = '建议=' + token + '。';
    services.sessions.setEntryState('session', 'prior', [{ key: 'coins', value: 'new value' }]);
    const evaluate = createCandidateEvaluator(snapshot, model, services.state);
    const full = evaluate(snapshot.historyEntries, '');
    const trimmed = evaluate(snapshot.historyEntries.slice(1), '');
    expect(full.messages[0]!.content).toBe('角色=' + value + '；预设=' + value);
    expect(full.messages.at(-1)!.content).toContain('建议=' + value + '。');
    expect(trimmed.messages[0]!.content).toBe('角色=；预设=');
    expect(trimmed.messages.at(-1)!.content).toContain('建议=。');
    expect(trimmed.messages.at(-2)!.content).toBe(token);
    expect(trimmed.activeRoots).toEqual([]);
    const next = captureContext(services, 'session');
    next.preset.config.nodes[0]!.prompt = token;
    expect(compileNarrativeContext(next, model).messages[0]!.content).toBe('new value');
    expect(full.estimatedInputTokens).toBeGreaterThan(trimmed.estimatedInputTokens);
    for (const compiled of [full, trimmed]) {
      expect(Object.values(compiled.context.contextComposition).reduce((sum, size) => sum + size, 0))
        .toBe(compiled.messages.reduce((sum, item) => sum + Buffer.byteLength(item.content) + 16, 0));
    }
  });

  it('counts emitted UTF-8 text by source, including framing, without counting skipped nodes', () => {
    append('prior', 'assistant', '历史🙂');
    const snapshot = capture('输入');
    snapshot.materials.variables['history.summary'] = { type: 'text', value: '摘要' };
    snapshot.materials.variables['persona.prompt'] = { type: 'text', value: '角色' };
    snapshot.preset.config.nodes.find(node => node.id === 'main')!.prompt = '规则{{persona.prompt}}';
    snapshot.preset.config.nodes.find(node => node.id === 'userInput')!.prompt = '问题：{{input.text}}';
    snapshot.preset.config.nodes.find(node => node.id === 'personaInfo')!.prompt = ' \n ';
    Object.assign(snapshot.preset.config.nodes.find(node => node.id === 'worldInfo')!, {
      enabled: false, prompt: 'This node is disabled.',
    });
    const compiled = compileNarrativeContext(snapshot, model);
    expect(compiled.messages.slice(0, -1).map(message => message.content)).toEqual(['规则角色', '摘要', withEmptyModelNotes('历史🙂'), '问题：输入']);
    const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
    expect(compiled.context).toEqual({
      apiModelConfigId: 'model', contextWindowTokens: model.contextWindow,
      contextComposition: {
        systemBytes: bytes('规则角色问题：') + bytes(compiled.messages.at(-1)!.content) + 4 * 16,
        summaryBytes: bytes('摘要'),
        historyBytes: bytes(withEmptyModelNotes('历史🙂') + '输入') + 16,
      },
    });
    expect(Object.values(compiled.context.contextComposition).reduce((total, count) => total + count, 0))
      .toBe(compiled.messages.reduce((total, message) => total + bytes(message.content) + 16, 0));
  });
});

describe('synchronous session snapshot', () => {
  it('supports an empty pre-submit tip without repeating the saved input or applying an opening', () => {
    const snapshot = capture();
    const compiled = compileNarrativeContext(snapshot, model);
    expect(snapshot.history).toEqual([]);
    expect(snapshot.views).toEqual({ global: { day: 2 }, session: { reputation: 3 }, message: {} });
    expect(compiled.messages.slice(0, -1)).toEqual([{ role: 'user', content: 'Current input', timestamp: 0 }]);
    expect(services.sessions.getHistory('session')).toHaveLength(1);
    expect(snapshot.materials.variables['history.summary']).toEqual({ type: 'text', value: '' });
  });

  it('reads message state at the actual tip and captures objects independent of later edits', () => {
    append('prior', 'assistant', 'Previous answer');
    services.sessions.setEntryState('session', 'prior', [{ key: 'coins', value: 5 }]);
    const snapshot = capture();
    services.worlds.update('world', { name: 'Changed', characters: [{ id: 'player', name: 'Different', player_selectable: true }] });
    services.sessions.setEntryState('session', 'prior', [{ key: 'coins', value: 99 }]);
    services.sessions.updateEntry('session', 'prior', { payload: { message: { role: 'assistant', content: 'Edited', timestamp: 100 } } });
    expect(snapshot.world.name).toBe('World');
    expect(snapshot.history.map(item => item.text)).toEqual(['Previous answer']);
    expect(snapshot.views.message).toEqual({ coins: 5 });
    expect(snapshot.materials.variables.user).toEqual({ type: 'text', value: 'Player' });
    expect(services.sessions.getEntryState('session', 'current-user')).toBeNull();
  });

  it('captures legacy compaction separately without treating it as a visible history message', () => {
    services.sessions.appendEntry('session', { id: 'summary', runId: 'summary', type: 'compaction', role: null, payload: { summary: 'Earlier' } });
    const captured = capture();
    expect(captured.history).toEqual([]);
    expect(captured.historyEntries[0]?.type).toBe('compaction');
    expect(services.sessions.require('session').tipEntryId).toBe('current-user');
  });

  it('rejects mismatched history roles rather than replacing malformed data with an empty message', () => {
    services.sessions.appendEntry('session', {
      id: 'bad', runId: 'bad', type: 'message', role: 'assistant',
      payload: { message: { role: 'user', content: 'Mismatch', timestamp: 100 } },
    });
    expect(() => capture()).toThrow('INVALID_NARRATIVE_HISTORY');
    expect(services.sessions.getEntry('session', 'current-user')).not.toBeNull();
  });

  it('uses only visible assistant body for prompt history and material activation', () => {
    append('prior-user', 'user', 'Previous input');
    services.sessions.appendEntry('session', {
      id: 'answer', runId: 'prior', type: 'message', role: 'assistant',
      payload: { message: {
        role: 'assistant', content: 'Visible harbor', timestamp: 100,
        reasoning_content: 'reasoning-secret',
        tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"place":"tool-secret"}' } }],
      } },
    });
    services.worlds.update('world', { lorebook: { entries: [
      { id: 'visible', content: 'Visible lore', load: { mode: 'on_mention', keywords: ['harbor'] } },
      { id: 'reasoning', content: 'Reasoning must not activate', load: { mode: 'on_mention', keywords: ['reasoning-secret'] } },
      { id: 'tool', content: 'Tool arguments must not activate', load: { mode: 'on_mention', keywords: ['tool-secret'] } },
    ] } });
    const snapshot = capture(), compiled = compileNarrativeContext(snapshot, model);
    expect(snapshot.history).toEqual([
      { id: 'prior-user', role: 'user', text: 'Previous input', timestamp: 100 },
      { id: 'answer', role: 'assistant', text: 'Visible harbor', timestamp: 100 },
    ]);
    expect(compiled.messages.slice(0, -1)).toEqual([
      { role: 'user', content: 'Previous input', timestamp: 100 },
      { role: 'assistant', content: withEmptyModelNotes('Visible harbor'), timestamp: 100 },
      { role: 'user', content: 'Current input', timestamp: 0 },
    ]);
    expect(snapshot.materials.variables['world.lore']).toEqual({ type: 'text', value: 'Visible lore' });
    expect(services.sessions.getEntry('session', 'answer')!.payload.message).toMatchObject({
      reasoning_content: 'reasoning-secret', tool_calls: [{ function: { arguments: '{"place":"tool-secret"}' } }],
    });
  });

  it.each([
    { name: 'reasoning only', content: '', reasoning_content: 'hidden-trigger', tool_calls: [] },
    {
      name: 'tool request only', content: '  ', reasoning_content: '',
      tool_calls: [{ index: 0, id: '', type: 'function', function: { name: '', arguments: '{"query":"hidden-trigger' } }],
    },
  ])('keeps a $name entry in storage while omitting an empty model turn and activation text', ({ content, reasoning_content, tool_calls }) => {
    append('prior-user', 'user', 'Previous input');
    const message = { role: 'assistant', content, reasoning_content, tool_calls, timestamp: 101 };
    services.sessions.appendEntry('session', {
      id: 'partial', runId: 'prior', type: 'message', role: 'assistant', payload: { message },
    });
    services.sessions.setEntryState('session', 'partial', [{ key: 'coins', value: 9 }]);
    services.worlds.update('world', { lorebook: { entries: [
      { id: 'hidden', content: 'Must stay inactive', load: { mode: 'on_mention', keywords: ['hidden-trigger'] } },
    ] } });
    const snapshot = capture(), compiled = compileNarrativeContext(snapshot, model);
    expect(snapshot.history).toEqual([{ id: 'prior-user', role: 'user', text: 'Previous input', timestamp: 100 }]);
    expect(compiled.messages.slice(0, -1)).toEqual([
      { role: 'user', content: 'Previous input', timestamp: 100 },
      { role: 'user', content: 'Current input', timestamp: 0 },
    ]);
    expect(snapshot.materials.variables['world.lore']).toEqual({ type: 'text', value: '' });
    expect(snapshot.views.message).toEqual({ coins: 9 });
    expect(services.sessions.getHistory('session').map(entry => entry.id)).toEqual(['prior-user', 'partial', 'current-user']);
    expect(services.sessions.getEntry('session', 'partial')!.payload).toEqual({ message });
  });

  it('does not fall back to defaults when a bound model reference is missing', () => {
    capture();
    const missing = { ...services, models: { require: () => { throw new Error('MODEL_CONFIG_NOT_FOUND'); } } };
    expect(() => captureContext(missing, 'session')).toThrow('MODEL_CONFIG_NOT_FOUND');
  });

  it('keeps an answered user in chronological history instead of moving it after the assistant', () => {
    append('current-user', 'user', 'Current input');
    append('other', 'assistant', 'Other append');
    const snapshot = captureContext(services, 'session');
    expect(snapshot.inputEntryId).toBeNull();
    expect(snapshot.inputText).toBe('');
    expect(compileNarrativeContext(snapshot, model).messages.slice(0, -1).map(message => message.content))
      .toEqual(['Current input', withEmptyModelNotes('Other append')]);
  });
});

describe('core narrative compilation', () => {
  it('expands history with its native roles and keeps custom nodes at their original positions', () => {
    const preset = services.presets.require('preset');
    preset.config.nodes[0]!.prompt = 'Main';
    preset.config.nodes.find(node => node.id === 'chatHistory')!.prompt = '{{history.summary}}Before\n{{history.messages}}\nAfter';
    preset.config.nodes.splice(5, 0, { id: 'custom', name: 'Custom', kind: 'text', role: 'assistant', enabled: true, prompt: 'A custom example' });
    services.presets.update('preset', { config: preset.config });
    append('u0', 'user', 'Past input');
    append('a0', 'assistant', 'Past answer');
    const compiled = compileNarrativeContext(capture(), model);
    expect(compiled.messages.slice(0, -1).map(item => [item.role, item.content])).toEqual([
      ['system', 'Main'], ['system', 'Before\n'], ['user', 'Past input'], ['assistant', withEmptyModelNotes('Past answer')],
      ['system', '\nAfter'], ['assistant', 'A custom example'], ['user', 'Current input'],
    ]);
    expect(compiled.messages.filter(item => item.content === 'Current input')).toHaveLength(1);
    expect(compiled.diagnostics.nodes.find(node => node.id === 'chatHistory')).toMatchObject({
      name: 'chatHistory', included: true, messageIndexes: [1, 2, 3, 4],
    });
    expect(compiled.diagnostics.nodes.find(node => node.id === 'custom')).toMatchObject({ name: 'Custom', messageIndexes: [5] });
    expect(compiled.diagnostics.nodes.find(node => node.id === 'worldState')).toMatchObject({
      source: 'preset', included: false, reason: 'no_active_state', messageIndexes: [],
    });
    expect(compiled.diagnostics.nodes.find(node => node.id === 'actionSuggestions')).toMatchObject({
      source: 'preset', included: true, messageIndexes: [7],
    });
    expect(compiled.diagnostics.nodes.at(-1)).toMatchObject({ id: 'postprocessProtocol', source: 'platform', messageIndexes: [7] });
    expect(compiled.diagnostics.messageCount).toBe(compiled.messages.length);
    expect(JSON.stringify(compiled.diagnostics)).not.toMatch(/Past input|Past answer|A custom example|Current input/);

  });

  it('renders read-only scopes in the world state node and custom prompts without authorizing state updates', () => {
    const field = (key: string) => ({ type: 'number', initial: 0, description: key, rules: { [key]: 'Rule' } });
    services.worlds.update('world', { stateDefinition: { schema_version: 2, scopes: {
      global: { day: field('day') }, session: { reputation: field('reputation') },
    } } });
    const config = services.presets.require('preset').config;
    config.nodes.push({ id: 'custom', name: 'Profile', kind: 'text', role: 'system', enabled: true,
      prompt: 'Profile {{state.session}}' });
    services.presets.update('preset', { config });
    const snapshot = capture();
    const compiled = compileNarrativeContext(snapshot, model);
    expect(compiled.activeRoots).toEqual([]);
    expect(compiled.messages.find(item => item.content.startsWith('Profile'))?.content).toContain('value: 3');
    const last = compiled.messages.at(-1)!.content;
    expect(last).toContain('value: 2');
    expect(last).toContain('value: 3');
    expect(last).toContain('本轮没有可写状态');
    expect(compiled.diagnostics.nodes.find(node => node.id === 'worldState')?.included).toBe(true);

    snapshot.preset.config.nodes.find(node => node.id === 'worldState')!.prompt = 'Global only {{state.global}}';
    const customized = compileNarrativeContext(snapshot, model).messages.at(-1)!.content;
    expect(customized).toContain('Global only');
    expect(customized).not.toContain('value: 3');
  });

  it('compiles over-budget candidates without trimming or rejecting them before context policy runs', () => {
    for (let index = 0; index < 7; index++) {
      append('u' + index, 'user', 'Input ' + index);
      append('a' + index, 'assistant', 'Answer ' + index);
    }
    const snapshot = capture(), rolling = compileNarrativeContext(snapshot, model);
    snapshot.preset.config.contextStrategy.strategy = 'sliding_window';
    const sliding = compileNarrativeContext(snapshot, model);
    expect(sliding.messages).toEqual(rolling.messages);
    expect(sliding.messages).toHaveLength(16);
    snapshot.preset.config.contextStrategy.maxContextTokens = sliding.estimatedInputTokens - 1;
    const over = compileNarrativeContext(snapshot, model);
    expect(over.estimatedInputTokens).toBeGreaterThan(over.inputBudget);
    expect(snapshot.history).toHaveLength(14);
  });

  it('includes declared capability instructions in the real budget without mixing them into history or summaries', () => {
    const preset = services.presets.getDefault();
    services.presets.update('preset', { config: preset.config });
    services.worlds.update('world', { stateDefinition: { schema_version: 2, scopes: { message: {
      coins: { type: 'number', initial: 5, description: 'Coins', rules: { coins: 'Track spending' } },
    } } } });
    append('prior', 'assistant', 'Earlier visible story');
    services.sessions.setEntryState('session', 'prior', [{ key: 'coins', value: 5 }]);
    const snapshot = capture(), compiled = compileNarrativeContext(snapshot, model);
    const protocol = compiled.messages.at(-1)!;
    expect(compiled.activeRoots).toEqual(['coins']);
    expect(protocol.role).toBe('system');
    expect(protocol.content).toContain('<state_update>');
    expect(protocol.content).toContain('JSONL');
    expect(protocol.content).toContain('<action_suggestions>');
    expect(protocol.content).toContain('coins');
    expect(compiled.messages.some(message => message.content.includes('Player prompt'))).toBe(true);
    expect(compiled.messages.map(message => message.content).join('\n')).not.toContain(preset.config.contextStrategy.summaryPrompt);
    expect(compiled.estimatedInputTokens).toBe(estimateInputTokens(compiled.messages));
    expect(compiled.estimatedInputTokens).toBeGreaterThan(estimateInputTokens(compiled.messages.slice(0, -1)));
    expect(snapshot.history.map(message => message.text)).toEqual(['Earlier visible story']);
    expect(snapshot.materials.variables['history.summary']).toEqual({ type: 'text', value: '' });
  });

  it('rejects a capability template that repeats historical material instead of falling back', () => {
    const snapshot = capture();
    snapshot.preset.config.nodes.find(node => node.id === 'actionSuggestions')!.prompt = '{{history.summary}}';
    expect(() => compileNarrativeContext(snapshot, model)).toThrow('INVALID_NARRATIVE_TEMPLATE');
  });

  it('leaves substituted input literal and handles escaped template delimiters', () => {
    const preset = services.presets.require('preset');
    preset.config.nodes[0]!.prompt = 'Literal \\{{user}} and {{user}}';
    services.presets.update('preset', { config: preset.config });
    const input = '{{history.messages}} <sr_extensions>literal</sr_extensions>';
    const compiled = compileNarrativeContext(capture(input), model);
    expect(compiled.messages[0]!.content).toBe('Literal {{user}} and Player');
    expect(compiled.messages.at(-2)!.content).toBe(input);
    expect(compiled.messages.at(-1)!.role).toBe('system');
    expect(() => parsePromptTemplate('{{unknown.path}}', systemVariableNames)).toThrow('INVALID_NARRATIVE_TEMPLATE');
    expect(() => parsePromptTemplate('{{user', systemVariableNames)).toThrow('INVALID_NARRATIVE_TEMPLATE');
  });

  it('rejects duplicate or misplaced input variables rather than sending a repeated user message', () => {
    const snapshot = capture();
    snapshot.preset.config.nodes[0]!.prompt = '{{input.text}}';
    expect(() => compileNarrativeContext(snapshot, model)).toThrow('INVALID_NARRATIVE_TEMPLATE');
  });

  it('honors generation settings and rejects an output limit larger than model capacity', () => {
    const snapshot = capture();
    snapshot.preset.config.modelParameters = { temperature: 0.4, thinkingEnabled: true, thinkingLevel: 'high' };
    const compiled = compileNarrativeContext(snapshot, { contextWindow: 6000, maxTokens: 4096 });
    expect(compiled).toMatchObject({ maxTokens: 4096, inputBudget: 880, modelParameters: { temperature: 0.4, thinkingEnabled: true, thinkingLevel: 'high' } });
    expect(() => compileNarrativeContext(snapshot, { contextWindow: 6000, maxTokens: 1000 })).toThrow('INVALID_MODEL_BUDGET');
    expect(() => compileNarrativeContext(snapshot, { contextWindow: 4096, maxTokens: 4096 })).toThrow('INVALID_MODEL_BUDGET');
  });
});

describe('context selection policies', () => {
  function configure(strategy: 'rolling_summary' | 'sliding_window', budget: number) {
    const preset = services.presets.require('preset');
    preset.config.contextStrategy.strategy = strategy;
    preset.config.contextStrategy.maxContextTokens = budget;
    services.presets.update('preset', { config: preset.config });
  }

  /** Preserve each fixture's history budget while accounting for the actual added protocol. */
  function captureBudgeted(inputText?: string) {
    const snapshot = capture(inputText);
    const compiled = compileNarrativeContext(snapshot, model);
    const protocolTokens = compiled.estimatedInputTokens - estimateInputTokens(compiled.messages.slice(0, -1));
    snapshot.preset.config.contextStrategy.maxContextTokens += protocolTokens;
    return snapshot;
  }

  it('slides at complete run boundaries and leaves persisted messages intact', () => {
    configure('sliding_window', 200);
    services.sessions.appendEntry('session', { id: 'u0', runId: 'past', type: 'message', role: 'user',
      payload: { message: { role: 'user', content: 'x'.repeat(1200), timestamp: 0 } } });
    services.sessions.appendEntry('session', { id: 'a0', runId: 'past', type: 'message', role: 'assistant',
      payload: { message: { role: 'assistant', content: 'Small answer', timestamp: 1 } } });
    append('recent', 'assistant', 'Recent');
    const selected = planContext(captureBudgeted(), model, services.state);
    expect(selected.summary).toBeUndefined();
    expect(selected.compiled.messages.slice(0, -1).map(message => message.content)).toEqual([withEmptyModelNotes('Recent'), 'Current input']);
    expect(services.sessions.getHistory('session')).toHaveLength(4);
  });

  it('keeps the longest candidate under the hard limit if no soft-target candidate exists, despite nonmonotonic activation', () => {
    configure('sliding_window', 200);
    const preset = services.presets.require('preset');
    preset.config.nodes.find(node => node.id === 'worldInfo')!.prompt = '{{world.lore}}';
    services.presets.update('preset', { config: preset.config });
    services.worlds.update('world', { lorebook: { entries: [{ id: 'dynamic', content: 'l'.repeat(1200),
      load: { mode: 'on_mention', keywords: ['Current'], exclude_keywords: ['suppress'] } }] } });
    append('old', 'assistant', 'x'.repeat(1200));
    append('kept', 'assistant', 'suppress ' + 's'.repeat(180));
    const selected = planContext(captureBudgeted(), model, services.state);
    expect(selected.compiled.messages.slice(0, -1).map(message => message.content)).toEqual([withEmptyModelNotes('suppress ' + 's'.repeat(180)), 'Current input']);
    expect(selected.compiled.estimatedInputTokens).toBeGreaterThan(selected.compiled.inputBudget * 0.6);
    expect(selected.compiled.estimatedInputTokens).toBeLessThanOrEqual(selected.compiled.inputBudget);
  });

  it('fails oversized current input rather than truncating it or deleting stored history', () => {
    configure('sliding_window', 200); append('prior', 'assistant', 'Before');
    const captured = captureBudgeted('x'.repeat(900));
    expect(() => planContext(captured, model, services.state)).toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect(services.sessions.getHistory('session')).toHaveLength(2);
  });

  it('never splits an interleaved run even when doing so would fit the context', () => {
    configure('sliding_window', 200);
    for (const [id, runId, content] of [['a', 'same', 'x'.repeat(1200)], ['b', 'middle', 'short'], ['c', 'same', 'end']]) {
      services.sessions.appendEntry('session', { id, runId: runId!, type: 'message', role: 'assistant',
        payload: { message: { role: 'assistant', content: content!, timestamp: 0 } } });
    }
    const captured = captureBudgeted();
    expect(historyBoundaries(captured.historyEntries)).toEqual([0, 3, 4]);
    expect(planContext(captured, model, services.state).compiled.messages.slice(0, -1).map(item => item.content)).toEqual(['Current input']);
  });

  it('protects the entire trailing user run instead of keeping only its last user message', () => {
    configure('sliding_window', 200);
    services.sessions.appendEntry('session', {
      id: 'same-run-prefix', runId: 'run-current-user', type: 'message', role: 'assistant',
      payload: { message: { role: 'assistant', content: 'x'.repeat(1200), timestamp: 0 } },
    });
    const captured = captureBudgeted();
    expect(() => planContext(captured, model, services.state)).toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect(services.sessions.getHistory('session').map(entry => entry.id)).toEqual(['same-run-prefix', 'current-user']);
  });

  it('protects five historical runs including an initial assistant and user-only/hidden-output runs', () => {
    configure('rolling_summary', 200);
    append('opening', 'assistant', 'x'.repeat(1200));
    append('user-only', 'user', 'Attempt');
    append('hidden', 'assistant', '');
    append('recent-a', 'assistant', 'Recent A');
    append('recent-b', 'assistant', 'Recent B');
    expect(() => planContext(captureBudgeted(), model, services.state)).toThrow('SUMMARY_CAPACITY_EXCEEDED');
  });

  it('switches to sliding using original messages rather than dropping already summarized source material', () => {
    configure('sliding_window', 500);
    append('old', 'assistant', 'Original story');
    const entries = services.sessions.getHistory('session');
    services.sessions.appendEntry('session', { id: 'compact', type: 'compaction', role: null, runId: 'compact-run',
      payload: { summary: 'Saved summary' }, extData: { summary: { coveredThroughEntryId: 'old', sourceHash: sourceHash(entries) } } });
    const selected = planContext(captureBudgeted(), model, services.state);
    expect(selected.compiled.messages.slice(0, -1).map(message => message.content)).toEqual([withEmptyModelNotes('Original story'), 'Current input']);
  });

  it('reuses only a summary with a valid complete boundary and unchanged covered source', () => {
    append('old', 'assistant', 'Original');
    const entries = services.sessions.getHistory('session');
    const metadata = { coveredThroughEntryId: 'old', sourceHash: sourceHash(entries) };
    const compact = services.sessions.appendEntry('session', { id: 'compact', type: 'compaction', role: null, runId: 'compact-run',
      payload: { summary: 'Saved summary' }, extData: { summary: metadata } });
    expect(readSummary([...entries, compact], entries)).toEqual({ text: 'Saved summary', coveredCount: 1 });
    expect(readSummary([...entries, { ...compact, extData: { summary: { ...metadata, sourceHash: 'stale' } } }], entries)).toBeNull();
    expect(readSummary([...entries, { ...compact, extData: { summary: { ...metadata, coveredThroughEntryId: 'other' } } }], entries)).toBeNull();
    expect(readSummary([...entries, { ...compact, extData: {} }], entries)).toBeNull();
    expect(planContext(captureBudgeted(), model, services.state).compiled.messages.slice(0, -1).map(message => message.content)).toEqual(['Saved summary', 'Current input']);
  });

  it('falls back to the latest valid summary and retains the edited uncovered suffix once', () => {
    append('old', 'assistant', 'Covered old story');
    const firstSource = services.sessions.getHistory('session');
    services.sessions.appendEntry('session', {
      id: 'first-summary', type: 'compaction', role: null, runId: 'run-old', payload: { summary: 'Valid older summary' },
      extData: { summary: { coveredThroughEntryId: 'old', sourceHash: sourceHash(firstSource) } },
    });
    append('recent', 'assistant', 'Original recent story');
    const secondSource = services.sessions.getHistory('session');
    services.sessions.appendEntry('session', {
      id: 'second-summary', type: 'compaction', role: null, runId: 'run-recent', payload: { summary: 'Stale newer summary' },
      extData: { summary: { coveredThroughEntryId: 'recent', sourceHash: sourceHash(secondSource) } },
    });
    services.sessions.updateEntry('session', 'recent', {
      payload: { message: { role: 'assistant', content: 'Edited recent story', timestamp: 100 } },
    });
    const compiled = planContext(captureBudgeted(), model, services.state).compiled;
    expect(compiled.messages.slice(0, -1).map(message => message.content))
      .toEqual(['Valid older summary', withEmptyModelNotes('Edited recent story'), 'Current input']);
  });

  it('does not let a stored summary consume the pending user run', () => {
    append('old', 'assistant', 'Old story');
    captureBudgeted();
    const entries = services.sessions.getHistory('session');
    services.sessions.appendEntry('session', {
      id: 'too-wide-summary', type: 'compaction', role: null, runId: 'run-current-user',
      payload: { summary: 'Includes pending user' },
      extData: { summary: { coveredThroughEntryId: 'current-user', sourceHash: sourceHash(entries) } },
    });
    const compiled = planContext(captureContext(services, 'session'), model, services.state).compiled;
    expect(compiled.messages.slice(0, -1).map(message => message.content)).toEqual([withEmptyModelNotes('Old story'), 'Current input']);
  });

  it.each(['{{history.messages}}', '{{history.summary}}{{history.summary}}{{history.messages}}'])('rejects missing or duplicate rolling-summary placement: %s', prompt => {
    const captured = captureBudgeted(); captured.preset.config.nodes.find(node => node.id === 'chatHistory')!.prompt = prompt;
    expect(() => planContext(captured, model, services.state)).toThrow('INVALID_NARRATIVE_TEMPLATE');
    captured.preset.config.contextStrategy.strategy = 'sliding_window';
    expect(() => planContext(captured, model, services.state)).not.toThrow();
  });

  it('excludes player instruction ranges from summary source but preserves visible story text', () => {
    expect(summaryNarrative('Story\n<sr_instruction>\nhidden instruction\n</sr_instruction>\nContinued', 'user')).not.toContain('hidden instruction');
    expect(summaryNarrative('Story\n<sr_instruction>\nhidden instruction\n</sr_instruction>\nContinued', 'user')).toContain('Continued');
  });
});

describe('model-only notes in context candidates', () => {
  it('renders captured notes only for model history, counts their tokens and leaves activation, summaries and storage clean', () => {
    services.sessions.appendNarrativeAssistant('session', {
      id: 'answer', runId: 'past', type: 'message', role: 'assistant',
      payload: { message: { role: 'assistant', content: 'A quiet room.', timestamp: 100 } },
    }, {
      stateUpdate: { status: 'success', updates: [{ status: 'success', path: 'coins', value: 8 }] },
      actionSuggestions: { status: 'success', items: ['note-only-keyword'] },
    });
    services.worlds.update('world', { lorebook: { entries: [
      { id: 'note-trigger', content: 'Must stay inactive', load: { mode: 'on_mention', keywords: ['note-only-keyword'] } },
    ] } });
    const snapshot = capture(), compiled = compileNarrativeContext(snapshot, model);
    expect(compiled.messages.find(message => message.role === 'assistant')?.content).toContain('note-only-keyword');
    expect(snapshot.history.map(message => message.text)).toEqual(['A quiet room.']);
    expect(snapshot.materials.variables['world.lore']).toEqual({ type: 'text', value: '' });
    expect(compiled.diagnostics.nodes.find(node => node.id === 'chatHistory')?.modelNoteEntryIds).toEqual(['answer']);
    expect(JSON.stringify(compiled.diagnostics.nodes)).not.toContain('note-only-keyword');
    expect(JSON.stringify(summaryRequest(model, 'Summarize', '', snapshot.history))).not.toContain('note-only-keyword');
    expect(services.sessions.getEntry('session', 'answer')?.payload.message).toMatchObject({ content: 'A quiet room.' });
    expect(snapshot.views.message).toEqual({});
    const clean = compileNarrativeContext({ ...snapshot, modelNotes: new Map() }, model);
    expect(compiled.estimatedInputTokens).toBeGreaterThan(clean.estimatedInputTokens);
    expect(compiled.estimatedInputTokens).toBe(estimateInputTokens(compiled.messages));
    const renderedHistory = compiled.messages.find(message => message.role === 'assistant')!.content;
    expect(compiled.context.contextComposition.historyBytes - clean.context.contextComposition.historyBytes)
      .toBe(Buffer.byteLength(renderedHistory, 'utf8') - Buffer.byteLength('A quiet room.', 'utf8'));
  });

  it('includes note text when choosing a sliding-window boundary and never transfers a removed note to another entry', () => {
    append('old', 'assistant', 'Older body');
    append('recent', 'assistant', 'Recent body');
    const snapshot = capture();
    snapshot.preset.config.contextStrategy.strategy = 'sliding_window';
    snapshot.preset.config.contextStrategy.maxContextTokens = compileNarrativeContext(snapshot, model).estimatedInputTokens + 10;
    expect(planContext(snapshot, model, services.state).compiled.messages.some(message => message.content === withEmptyModelNotes('Older body'))).toBe(true);
    snapshot.historyEntries.find(entry => entry.id === 'old')!.extData.output = {
      actionSuggestions: { status: 'success', items: Array.from({ length: 180 }, (_, index) => 'large-note-marker ' + index + ' ' + 'x'.repeat(20)) },
    };
    const selected = planContext(snapshot, model, services.state).compiled;
    expect(selected.messages.some(message => message.content.includes('Older body'))).toBe(false);
    expect(selected.messages.some(message => message.content.includes('large-note-marker'))).toBe(false);
    expect(selected.estimatedInputTokens).toBeLessThanOrEqual(selected.inputBudget);
    expect(snapshot.history.map(message => message.id)).toEqual(['old', 'recent']);
    expect(services.sessions.getHistory('session').map(entry => entry.id)).toEqual(['old', 'recent', 'current-user']);
  });
});

describe('compaction stage without persistence', () => {
  function summarySnapshot() {
    for (let index = 0; index < 8; index++) append('past-' + index, 'assistant', index < 3 ? 'x'.repeat(1200) : 'Recent ' + index);
    const snapshot = capture();
    const compiled = compileNarrativeContext(snapshot, model);
    const protocolTokens = compiled.estimatedInputTokens - estimateInputTokens(compiled.messages.slice(0, -1));
    snapshot.preset.config.contextStrategy.maxContextTokens = 300 + protocolTokens;
    return snapshot;
  }

  it('returns one successful summary draft without writing entries and keeps summary input free of notes', async () => {
    const snapshot = summarySnapshot();
    snapshot.historyEntries.find(entry => entry.id === 'past-0')!.extData.output = {
      actionSuggestions: { status: 'success', items: ['old-note-marker'] },
    };
    const summarize = vi.fn(async () => ({ ok: true as const, text: 'summary', metrics: null }));
    const result = await compactHistory(snapshot, model, services.state, summarize, new AbortController().signal);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(summarize.mock.calls[0])).not.toContain('old-note-marker');
    expect(result.summaryDraft).toMatchObject({ text: 'summary', coveredThroughEntryId: 'past-2', metrics: null });
    expect(result.failure).toBeUndefined();
    expect(result.compiled.messages.some(message => message.content === 'summary')).toBe(true);
    expect(services.sessions.getHistory('session')).toHaveLength(9);
    expect(services.sessions.require('session').tipEntryId).toBe('current-user');
  });

  it('retains a successful summary draft when the final request still exceeds capacity', async () => {
    const snapshot = summarySnapshot();
    const summarize = vi.fn(async () => ({ ok: true as const, text: 's'.repeat(6000), metrics: null }));
    const result = await compactHistory(snapshot, model, services.state, summarize, new AbortController().signal);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.summaryDraft?.text).toHaveLength(6000);
    expect(result.failure).toBe('summary_capacity_exceeded');
    expect(services.sessions.getHistory('session')).toHaveLength(9);
  });

  it('retains a successful summary draft if final assembly fails', async () => {
    const snapshot = summarySnapshot(), failure = new AppError('INVALID_NARRATIVE_TEMPLATE');
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    const summarize = async () => {
      spy = vi.spyOn(assembly, 'compileNarrativeContext').mockImplementationOnce(() => { throw failure; });
      return { ok: true as const, text: 'summary', metrics: null };
    };
    try {
      const result = await compactHistory(snapshot, model, services.state, summarize, new AbortController().signal);
      expect(result.summaryDraft?.text).toBe('summary');
      expect(result.failure).toBe(failure);
      expect(services.sessions.getHistory('session')).toHaveLength(9);
    } finally { spy?.mockRestore(); }
  });

  it('returns no draft for failed or cancelled summaries', async () => {
    const snapshot = summarySnapshot();
    const failed = await compactHistory(snapshot, model, services.state, async () => ({ ok: false }), new AbortController().signal);
    expect(failed.summaryDraft).toBeUndefined();
    expect(failed.failure).toBe('summary_failed');
    const controller = new AbortController();
    await expect(compactHistory(snapshot, model, services.state, async () => {
      controller.abort();
      return { ok: true, text: 'Late summary', metrics: null };
    }, controller.signal)).rejects.toThrow('RUN_STOPPED');
    expect(services.sessions.getHistory('session')).toHaveLength(9);
  });
});

describe('character sprite context', () => {
  function spritesWorld() {
    services.worlds.update('world', { characters: [
      { id: 'player', name: 'Player', player_selectable: true, prompt: 'Player prompt' },
      { id: 'alice', name: 'Alice', prompt: 'Hidden character prompt', load: { mode: 'never' },
        sprites: [
          { id: 'default', description: 'calm sprite description', asset: 'https://example.com/default.png' },
          { id: 'smile', description: 'smiling sprite description', asset: 'https://example.com/smile.png' },
        ] },
    ] });
  }

  it('captures the entire directory independently of character load and renders only selection metadata', () => {
    spritesWorld(); append('prior', 'assistant', 'Earlier scene');
    const snapshot = capture(), compiled = compileNarrativeContext(snapshot, model);
    expect(compiled.characterSpriteCatalog).toHaveLength(2);
    expect(compiled.characterSpriteCatalog[0]).toMatchObject({ characterId: 'alice', asset: 'https://example.com/default.png' });
    const variable = snapshot.materials.variables['characterSprite.catalog'];
    expect(variable.type).toBe('text');
    expect(variable.value).toContain('"playerCharacterId":"player"');
    expect(variable.value).toContain('calm sprite description');
    expect(variable.value).not.toContain('https://');
    expect(variable.value).not.toContain('Hidden character prompt');
    expect(snapshot.materials.variables['characters.prompts'].value).toBe('');
    const prompt = compiled.messages.at(-1)!.content;
    expect(prompt).toContain('character_sprite 使用扁平 JSONL');
    expect(prompt).toContain('truecenter');
    expect(prompt).toContain('超过两个角色');
    expect(compiled.messages.find(item => item.role === 'assistant')?.content).toContain('<character_sprite></character_sprite>');
    expect(compiled.estimatedInputTokens).toBe(estimateInputTokens(compiled.messages));
  });

  it.each(['disabled', 'missing', 'no_sprites'] as const)('omits prompt, variable and historical block when %s', condition => {
    if (condition !== 'no_sprites') spritesWorld();
    const config = services.presets.require('preset').config;
    if (condition === 'disabled') config.nodes.find(node => node.id === 'characterSprite')!.enabled = false;
    if (condition === 'missing') config.nodes = config.nodes.filter(node => node.id !== 'characterSprite');
    config.nodes[0]!.prompt = 'Catalog={{characterSprite.catalog}}';
    services.presets.update('preset', { config });
    append('prior', 'assistant', 'Earlier scene');
    const snapshot = capture(), compiled = compileNarrativeContext(snapshot, model);
    expect(snapshot.materials.variables['characterSprite.catalog'].value).toBe('');
    expect(compiled.messages[0]?.content).toBe('Catalog=');
    expect(compiled.messages.map(item => item.content).join('\n')).not.toContain('character_sprite');
    expect(compiled.characterSpriteCatalog).toHaveLength(condition === 'no_sprites' ? 0 : 2);
  });

  it('disables state and actions in both current instructions and historical notes without changing active roots', () => {
    services.worlds.update('world', { stateDefinition: { schema_version: 2, scopes: { message: {
      coins: { type: 'number', initial: 0, description: 'Coins' },
    } } } });
    const config = services.presets.require('preset').config;
    for (const node of config.nodes) if (node.kind === 'postprocess') node.enabled = false;
    services.presets.update('preset', { config });
    append('prior', 'assistant', 'Earlier scene');
    const snapshot = capture(), compiled = compileNarrativeContext(snapshot, model);
    expect(compiled.activeRoots).toEqual(['coins']);
    expect(compiled.messages.find(item => item.role === 'assistant')?.content).toBe('Earlier scene');
    expect(compiled.messages.at(-1)?.content).toBe('Current input');
    expect(compiled.messages.map(item => item.content).join('\n')).not.toMatch(/state_update|action_suggestions|character_sprite/);
    expect(compiled.diagnostics.nodes.filter(node => node.kind === 'postprocess').every(node => !node.included)).toBe(true);
  });

  it('re-evaluates state source availability after trimming without reviving older assistant notes', () => {
    services.worlds.update('world', { stateDefinition: { schema_version: 2, scopes: { message: {
      coins: { type: 'number', initial: 0, description: 'Coins', load: { mode: 'on_mention', keywords: ['gate'] } },
    } } } });
    append('old', 'assistant', 'gate');
    append('recent', 'assistant', 'Recent scene');
    const snapshot = capture();
    const evaluate = createCandidateEvaluator(snapshot, model, services.state);
    expect(evaluate(snapshot.historyEntries, '').messages.find(item => item.content.startsWith('Recent scene'))?.content)
      .toContain('<state_update>');
    const trimmed = evaluate(snapshot.historyEntries.slice(1), '');
    expect(trimmed.activeRoots).toEqual([]);
    expect(trimmed.messages.find(item => item.content.startsWith('Recent scene'))?.content).not.toContain('<state_update>');
  });
});
