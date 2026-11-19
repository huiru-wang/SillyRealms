import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { createServices, type Services } from '../../services.js';
import { narrativePreset } from '../../testing/fixtures.js';
import { captureNarrativeContext } from './context.js';
import { compileNarrativeContext, parsePromptTemplate } from './compile.js';

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

describe('synchronous narrative snapshot', () => {
  it('supports an empty pre-submit tip without repeating the saved input or applying an opening', () => {
    const snapshot = capture();
    const compiled = compileNarrativeContext(snapshot, model);
    expect(snapshot.history).toEqual([]);
    expect(snapshot.views).toEqual({ global: { day: 2 }, session: { reputation: 3 }, message: {} });
    expect(compiled.messages).toEqual([{ role: 'user', content: 'Current input', timestamp: 0 }]);
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

  it('rejects unsupported compaction and invalid messages after leaving the submitted user saved', () => {
    services.sessions.appendEntry('session', { id: 'summary', runId: 'summary', type: 'compaction', role: null, payload: { summary: 'Earlier' } });
    expect(() => capture()).toThrow('NARRATIVE_HISTORY_UNSUPPORTED');
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
    expect(compiled.messages).toEqual([
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
    expect(compiled.messages).toEqual([
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
    preset.config.nodes.find(node => node.id === 'chatHistory')!.prompt = 'Before\n{{history.messages}}\nAfter';
    preset.config.nodes.splice(5, 0, { id: 'custom', name: 'Custom', kind: 'text', role: 'assistant', enabled: true, prompt: 'A custom example' });
    services.presets.update('preset', { config: preset.config });
    append('u0', 'user', 'Past input');
    append('a0', 'assistant', 'Past answer');
    const compiled = compileNarrativeContext(capture(), model);
    expect(compiled.messages.map(item => [item.role, item.content])).toEqual([
      ['system', 'Main'], ['system', 'Before\n'], ['user', 'Past input'], ['assistant', 'Past answer'],
      ['system', '\nAfter'], ['assistant', 'A custom example'], ['user', 'Current input'],
    ]);
    expect(compiled.messages.filter(item => item.content === 'Current input')).toHaveLength(1);
  });

  it('retains all history for either configured strategy and fails budgets without silently trimming', () => {
    for (let index = 0; index < 7; index++) {
      append('u' + index, 'user', 'Input ' + index);
      append('a' + index, 'assistant', 'Answer ' + index);
    }
    const snapshot = capture(), rolling = compileNarrativeContext(snapshot, model);
    snapshot.preset.config.contextStrategy.strategy = 'sliding_window';
    const sliding = compileNarrativeContext(snapshot, model);
    expect(sliding.messages).toEqual(rolling.messages);
    expect(sliding.messages).toHaveLength(15);
    snapshot.preset.config.contextStrategy.maxContextTokens = sliding.estimatedInputTokens - 1;
    expect(() => compileNarrativeContext(snapshot, model)).toThrow('CONTEXT_BUDGET_EXCEEDED');
    expect(snapshot.history).toHaveLength(14);
  });

  it('excludes default postprocess instructions and never executes a summary request', () => {
    const preset = services.presets.getDefault();
    services.presets.update('preset', { config: preset.config });
    const snapshot = capture();
    const compiled = compileNarrativeContext(snapshot, model), text = compiled.messages.map(item => item.content).join('\n');
    expect(text).toContain('Player prompt');
    expect(text).not.toContain('<state_update>');
    expect(text).not.toContain('<action_suggestions>');
    expect(text).not.toContain(preset.config.contextStrategy.summaryPrompt);
    expect(snapshot.materials.variables['history.summary']).toEqual({ type: 'text', value: '' });
  });

  it('leaves substituted input literal and handles escaped template delimiters', () => {
    const preset = services.presets.require('preset');
    preset.config.nodes[0]!.prompt = 'Literal \\{{user}} and {{user}}';
    services.presets.update('preset', { config: preset.config });
    const input = '{{history.messages}} <sr_extensions>literal</sr_extensions>';
    const compiled = compileNarrativeContext(capture(input), model);
    expect(compiled.messages[0]!.content).toBe('Literal {{user}} and Player');
    expect(compiled.messages.at(-1)!.content).toBe(input);
    expect(() => parsePromptTemplate('{{unknown.path}}')).toThrow('INVALID_NARRATIVE_TEMPLATE');
    expect(() => parsePromptTemplate('{{user')).toThrow('INVALID_NARRATIVE_TEMPLATE');
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
    expect(compiled).toMatchObject({ maxTokens: 4096, inputBudget: 1904, temperature: 0.4, thinkingEnabled: true });
    expect(() => compileNarrativeContext(snapshot, { contextWindow: 6000, maxTokens: 1000 })).toThrow('INVALID_MODEL_BUDGET');
    expect(() => compileNarrativeContext(snapshot, { contextWindow: 4096, maxTokens: 4096 })).toThrow('INVALID_MODEL_BUDGET');
  });
});
