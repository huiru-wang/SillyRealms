import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../../errors.js';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { createServices, type Services } from '../../services.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { planContext as planHistoryContext } from './stages/compact/plan.js';
import { historyBoundaries } from './stages/history/index.js';
import { readSummary, sourceHash } from './stages/compact/saved-summary.js';
import { summaryNarrative, summaryRequest } from './stages/compact/summary-request.js';
import { compactHistory as compactCandidateHistory, type Summarize } from './stages/compact/index.js';
import { createCandidateEvaluator } from './candidate.js';
import { captureNarrativeContext, type NarrativeSnapshot } from './capture.js';
import { compileNarrativeContext } from './stages/assemble/index.js';
import * as assembly from './stages/assemble/index.js';
import { estimateInputTokens } from './lib/estimate.js';
import { parsePromptTemplate } from './lib/template.js';
import { systemVariableNames } from './stages/materials/index.js';

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
  const previousTipEntryId = services.sessions.require('session').tipEntryId;
  append('current-user', 'user', inputText);
  return captureNarrativeContext(services, { sessionId: 'session', userEntryId: 'current-user', previousTipEntryId, inputText });
}

function planContext(snapshot: NarrativeSnapshot, selectedModel: typeof model, state: Pick<Services['state'], 'evaluateWhen'>) {
  return planHistoryContext({
    historyEntries: snapshot.historyEntries, contextStrategy: snapshot.preset.config.contextStrategy,
  }, selectedModel, createCandidateEvaluator(snapshot, selectedModel, state));
}
function compactHistory(snapshot: NarrativeSnapshot, selectedModel: typeof model,
  state: Pick<Services['state'], 'evaluateWhen'>, summarize: Summarize, signal: AbortSignal) {
  return compactCandidateHistory({
    historyEntries: snapshot.historyEntries, contextStrategy: snapshot.preset.config.contextStrategy,
  }, selectedModel, createCandidateEvaluator(snapshot, selectedModel, state), summarize, signal);
}

describe('synchronous narrative snapshot', () => {
  it('supports an empty pre-submit tip without repeating the saved input or applying an opening', () => {
    const snapshot = capture();
    const compiled = compileNarrativeContext(snapshot, model);
    expect(snapshot.history).toEqual([]);
    expect(snapshot.views).toEqual({ global: { day: 2 }, session: { reputation: 3 }, message: {} });
    expect(compiled.messages.slice(0, -1)).toEqual([{ role: 'user', content: 'Current input', timestamp: 0 }]);
    expect(services.sessions.getHistory('session')).toHaveLength(1);
    expect(snapshot.materials.variables['history.summary']).toEqual({ type: 'text', value: '' });
  });

  it('reads message state at the original tip and captures objects independent of later edits', () => {
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
      { role: 'assistant', content: 'Visible harbor', timestamp: 100 },
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
    const snapshot = capture();
    const missing = { ...services, models: { require: () => { throw new Error('MODEL_CONFIG_NOT_FOUND'); } } };
    expect(() => captureNarrativeContext(missing, {
      sessionId: 'session', userEntryId: 'current-user', previousTipEntryId: null, inputText: snapshot.inputText,
    })).toThrow('MODEL_CONFIG_NOT_FOUND');
  });

  it('does not accidentally remove a different appended message from the snapshot', () => {
    append('current-user', 'user', 'Current input');
    append('other', 'assistant', 'Other append');
    expect(() => captureNarrativeContext(services, {
      sessionId: 'session', userEntryId: 'current-user', previousTipEntryId: null, inputText: 'Current input',
    })).toThrow('TIP_CONFLICT');
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
      ['system', 'Main'], ['system', 'Before\n'], ['user', 'Past input'], ['assistant', 'Past answer'],
      ['system', '\nAfter'], ['assistant', 'A custom example'], ['user', 'Current input'],
    ]);
    expect(compiled.messages.filter(item => item.content === 'Current input')).toHaveLength(1);
    expect(compiled.diagnostics.nodes.find(node => node.id === 'chatHistory')).toMatchObject({
      name: 'chatHistory', included: true, messageIndexes: [1, 2, 3, 4],
    });
    expect(compiled.diagnostics.nodes.find(node => node.id === 'custom')).toMatchObject({ name: 'Custom', messageIndexes: [5] });
    expect(compiled.diagnostics.nodes.find(node => node.id === 'worldState')).toMatchObject({
      source: 'default', included: false, reason: 'no_active_state', messageIndexes: [],
    });
    expect(compiled.diagnostics.nodes.find(node => node.id === 'actionSuggestions')).toMatchObject({
      source: 'default', included: true, messageIndexes: [7],
    });
    expect(compiled.diagnostics.nodes.at(-1)).toMatchObject({ id: 'postprocessProtocol', source: 'platform', messageIndexes: [7] });
    expect(compiled.diagnostics.messageCount).toBe(compiled.messages.length);
    expect(JSON.stringify(compiled.diagnostics)).not.toMatch(/Past input|Past answer|A custom example|Current input/);

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

  it('includes default capability instructions in the real budget without mixing them into history or summaries', () => {
    const preset = services.presets.getDefault();
    for (const node of preset.config.nodes) if (node.kind === 'postprocess') node.enabled = false;
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

  it('does not duplicate the summary through a custom postprocess template', () => {
    const snapshot = capture();
    snapshot.materials.variables['history.summary'] = { type: 'text', value: 'unique-summary-marker' };
    snapshot.preset.config.nodes.push({
      id: 'actionSuggestions', name: 'Actions', kind: 'postprocess', role: 'system',
      enabled: true, prompt: '{{history.summary}}',
    });
    const compiled = compileNarrativeContext(snapshot, model);
    const joined = compiled.messages.map(message => message.content).join('\n');
    expect(joined.match(/unique-summary-marker/g)).toHaveLength(1);
    expect(compiled.messages.at(-1)?.content).toContain('<action_suggestions>');
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
    snapshot.preset.config.modelParameters = { temperature: 0.4, thinkingEnabled: true };
    const compiled = compileNarrativeContext(snapshot, { contextWindow: 6000, maxTokens: 4096 });
    expect(compiled).toMatchObject({ maxTokens: 4096, inputBudget: 880, temperature: 0.4, thinkingEnabled: true });
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
    expect(selected.compiled.messages.slice(0, -1).map(message => message.content)).toEqual(['Recent', 'Current input']);
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
    expect(selected.compiled.messages.slice(0, -1).map(message => message.content)).toEqual(['suppress ' + 's'.repeat(180), 'Current input']);
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
    expect(historyBoundaries(captured.historyEntries)).toEqual([0, 3]);
    expect(planContext(captured, model, services.state).compiled.messages.slice(0, -1).map(item => item.content)).toEqual(['Current input']);
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
    expect(selected.compiled.messages.slice(0, -1).map(message => message.content)).toEqual(['Original story', 'Current input']);
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
      stateUpdate: { status: 'success', updates: [{ path: 'coins', value: 8 }], results: [{ status: 'success', path: 'coins' }] },
      actionSuggestions: { status: 'success', items: ['note-only-keyword'], results: [{ status: 'success' }] },
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
  });

  it('includes note text when choosing a sliding-window boundary and never transfers a removed note to another entry', () => {
    append('old', 'assistant', 'Older body');
    append('recent', 'assistant', 'Recent body');
    const snapshot = capture();
    snapshot.preset.config.contextStrategy.strategy = 'sliding_window';
    snapshot.preset.config.contextStrategy.maxContextTokens = compileNarrativeContext(snapshot, model).estimatedInputTokens + 10;
    expect(planContext(snapshot, model, services.state).compiled.messages.some(message => message.content === 'Older body')).toBe(true);
    snapshot.modelNotes = new Map([['old', [{ source: 'example', content: 'large-note-marker ' + 'x'.repeat(6000) }]]]);
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
    snapshot.modelNotes = new Map([['past-0', [{ source: 'example', content: 'old-note-marker' }]]]);
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
