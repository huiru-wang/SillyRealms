import { expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { contextFixture } from './fixtures/context.js';
import { compileContext } from '../src/runtime/context/node-compiler.js';
import { resolveBudget } from '../src/domain/preset-budget.js';

const textOf = (message: Message) => typeof message.content === 'string' ? message.content
  : message.content.map(part => part.type === 'text' ? part.text : '').join('');

it('compiles template nodes in order with original history roles and no session background', () => {
  const input = contextFixture(), context = compileContext(input), text = JSON.stringify(context.messages);
  for (const content of ['PLAYER', 'NPC', 'LORE', 'SUMMARY', 'OLD_USER', 'OLD_STORY', 'CURRENT forest', '奖励增加10'])
    expect(text).toContain(content);
  for (const content of ['SESSION_BACKGROUND', '会话背景', 'GLOBAL_PRIVATE', 'PRIVATE_DESCRIPTION', 'HIDDEN', 'readonly_state', 'sr_extensions'])
    expect(text).not.toContain(content);
  expect(context.trace.filter(row => row.messages.length).map(row => row.nodeId))
    .toEqual(['main', 'personaInfo', 'characterInfo', 'worldInfo', 'chatHistory', 'userInput', 'worldState', 'actionSuggestions']);
  expect(context.trace.find(row => row.nodeId === 'chatHistory')!.messages.map(message => message.role))
    .toEqual(['system', 'user', 'assistant']);
  expect(context.activeRoots).toEqual(['score']);
  expect(context.postprocess.state_update.required).toBe(true);
  expect(Object.isFrozen(context.messages)).toBe(true);
});

it('expands history at its template position and keeps text before and after it as system messages', () => {
  const input = contextFixture();
  input.nodes.find(node => node.id === 'chatHistory')!.prompt =
    'Before\n{{history.summary}}\n{{history.messages}}\nAfter';
  const messages = compileContext(input).trace.find(row => row.nodeId === 'chatHistory')!.messages;
  expect(messages.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'system']);
  expect(messages.map(textOf)).toEqual(['Before\nSUMMARY\n', 'OLD_USER', 'OLD_STORY', '\nAfter']);
});

it('does not emit empty messages when optional materials and retained history are empty', () => {
  const input = contextFixture();
  input.history = [];
  input.nodes.find(node => node.id === 'chatHistory')!.prompt = '{{history.summary}}{{history.messages}}';
  input.nodes.find(node => node.id === 'main')!.prompt = '';
  input.nodes.find(node => node.id === 'personaInfo')!.prompt = '{{persona.prompt}}';
  input.world.characters[0]!.load = { mode: 'never' };
  const context = compileContext(input);
  for (const id of ['main', 'personaInfo', 'chatHistory'])
    expect(context.trace.find(row => row.nodeId === id)!.messages).toEqual([]);
  expect(context.messages.every(message => textOf(message).trim())).toBe(true);
});

it('resolves variables only in templates while keeping existing user macros in world materials', () => {
  const input = contextFixture();
  input.world.characters[0]!.prompt = 'PLAYER {{user}} {{history.messages}}';
  input.world.lorebook!.entries[0]!.content = 'LORE {{user}} {{input.text}}';
  input.history[0]!.text = 'SUMMARY {{user}} {{persona.prompt}}';
  input.history[1]!.text = 'OLD_USER {{world.lore}}';
  input.history[2]!.text = 'OLD_STORY {{history.messages}}';
  input.input = 'CURRENT {{persona.prompt}}\n<sr_instruction>Keep this verbatim.</sr_instruction>';
  input.nodes.find(node => node.id === 'main')!.prompt = 'For {{user}}: {{persona.prompt}}';
  input.nodes.unshift({
    id: 'cross-source', name: 'Cross source', kind: 'text', role: 'assistant', enabled: true,
    prompt: '{{world.lore}}\n{{history.summary}}\n{{history.summary}}',
  });
  const context = compileContext(input);
  expect(context.trace.find(row => row.nodeId === 'main')!.messages.map(textOf))
    .toEqual(['For 玩家: PLAYER 玩家 {{history.messages}}']);
  expect(context.trace.find(row => row.nodeId === 'cross-source')!.messages.map(textOf))
    .toEqual(['LORE 玩家 {{input.text}}\nSUMMARY {{user}} {{persona.prompt}}\nSUMMARY {{user}} {{persona.prompt}}']);
  expect(context.trace.find(row => row.nodeId === 'chatHistory')!.messages.slice(1).map(textOf))
    .toEqual(['OLD_USER {{world.lore}}', 'OLD_STORY {{history.messages}}']);
  expect(context.trace.find(row => row.nodeId === 'userInput')!.messages.map(textOf))
    .toEqual([input.input]);
});

it('renders quoted literal placeholders and preserves backslashes without recursive interpolation', () => {
  const input = contextFixture();
  input.nodes.find(node => node.id === 'main')!.prompt =
    '\\{{unknown.variable}} | {{user}} | \\\\{{user}} | C:\\story\\notes';
  const messages = compileContext(input).trace.find(row => row.nodeId === 'main')!.messages;
  expect(messages.map(textOf)).toEqual(['{{unknown.variable}} | 玩家 | \\玩家 | C:\\story\\notes']);
});

it('lets the user-input template add text while preserving the raw input and its role', () => {
  const input = contextFixture();
  input.input = '<sr_instruction>\n{{history.messages}}\n</sr_instruction>';
  input.nodes.find(node => node.id === 'userInput')!.prompt = 'Player input:\n{{input.text}}\nEnd.';
  const messages = compileContext(input).trace.find(row => row.nodeId === 'userInput')!.messages;
  expect(messages.map(message => message.role)).toEqual(['user']);
  expect(messages.map(textOf)).toEqual(['Player input:\n' + input.input + '\nEnd.']);
  expect(input.input).toBe('<sr_instruction>\n{{history.messages}}\n</sr_instruction>');
});

it('keeps session state available to loading rules without serializing it into the prompt', () => {
  const input = contextFixture();
  input.world.lorebook!.entries[0]!.load = {
    mode: 'always', when: "getState('place', {scope:'session'}) === 'SESSION_BACKGROUND'",
  };
  const active = JSON.stringify(compileContext(input).messages);
  expect(active).toContain('LORE');
  expect(active).not.toContain('SESSION_BACKGROUND');
  input.views.session.place = 'OTHER_PLACE';
  const inactive = JSON.stringify(compileContext(input).messages);
  expect(inactive).not.toContain('LORE');
  expect(inactive).not.toContain('OTHER_PLACE');
});

it('node switches control prompt and parser together; no active root omits all state instructions', () => {
  for (const state of [false, true]) for (const suggestions of [false, true]) {
    const input = contextFixture();
    input.nodes.find(node => node.id === 'worldState')!.enabled = state;
    input.nodes.find(node => node.id === 'actionSuggestions')!.enabled = suggestions;
    const context = compileContext(input), text = JSON.stringify(context.messages);
    expect(text.includes('<state_update>')).toBe(state);
    expect(text.includes('<action_suggestions>')).toBe(suggestions);
    expect(context.postprocess.state_update.enabled).toBe(state);
    expect(context.postprocess.action_suggestions.enabled).toBe(suggestions);
  }
  const input = contextFixture();
  input.world.state!.scopes.message!.score!.load = { mode: 'never' };
  const context = compileContext(input);
  expect(context.activeRoots).toEqual([]);
  expect(context.trace.find(row => row.nodeId === 'worldState')!.messages).toEqual([]);
  expect(context.messages.some(message => typeof message.content === 'string' && message.content.startsWith('<世界状态>\n')))
    .toBe(false);
});

it('activation uses only supplied retained history and input', () => {
  const input = contextFixture();
  input.input = 'continue';
  expect(JSON.stringify(compileContext(input).messages)).not.toContain('NPC');
  input.history.push({ id: 'recent', role: 'user', text: 'forest' });
  expect(JSON.stringify(compileContext(input).messages)).toContain('NPC');
  input.world.characters[0]!.load = { mode: 'never' };
  expect(JSON.stringify(compileContext(input).messages)).not.toContain('PLAYER');
});

it('caps numeric input budget at 80% and reserves output plus safety', () => {
  const base = { strategy: 'rolling_summary' as const, max_context_tokens: 160000, max_output_tokens: 4096 };
  const model = { contextWindow: 200000, maxTokens: 100000 };
  expect(resolveBudget(base, model)).toEqual(base);
  expect(() => resolveBudget({ ...base, max_context_tokens: 160001 }, model)).toThrow();
  expect(() => resolveBudget({ ...base, max_output_tokens: 50000 }, model)).toThrow();
});

it('classifies only emitted material occurrences and template wrappers in context composition', () => {
  const input = contextFixture();
  for (const node of input.nodes) {
    if (node.kind === 'postprocess') node.enabled = false;
    else if (node.id === 'main') node.prompt = '框架';
    else if (node.id === 'chatHistory') node.prompt = '摘要：{{history.summary}}{{history.messages}}结束';
    else if (node.id === 'userInput') node.prompt = '输入：{{input.text}}';
    else node.prompt = '';
  }
  input.history = [
    { id: 'summary', role: 'assistant', text: '摘要🙂' },
    { id: 'u', role: 'user', text: 'U' },
    { id: 'a', role: 'assistant', text: 'A' },
  ];
  input.input = '当前输入';
  const context = compileContext(input);
  expect(context.composition).toEqual({
    systemBytes: Buffer.byteLength('框架摘要：结束输入：', 'utf8') + 4 * 16,
    summaryBytes: Buffer.byteLength('摘要🙂', 'utf8'),
    historyBytes: Buffer.byteLength('UA当前输入', 'utf8') + 2 * 16,
  });
  expect(Object.values(context.composition).reduce((sum, value) => sum + value, 0))
    .toBe(context.messages.reduce((sum, message) => sum + Buffer.byteLength(textOf(message), 'utf8') + 16, 0));
});

it('counts repeated summary references where sent and excludes unreferenced or disabled summaries', () => {
  const input = contextFixture();
  input.nodes.find(node => node.id === 'chatHistory')!.prompt = '{{history.messages}}';
  expect(compileContext(input).composition.summaryBytes).toBe(0);
  const summaryNode = {
    id: 'repeat-summary', name: 'Repeat summary', kind: 'text' as const, role: 'assistant' as const,
    enabled: true, prompt: '{{history.summary}} / {{history.summary}}',
  };
  input.nodes.push(summaryNode);
  const repeated = compileContext(input);
  expect(repeated.composition.summaryBytes).toBe(2 * Buffer.byteLength('SUMMARY', 'utf8'));
  summaryNode.enabled = false;
  const disabled = compileContext(input);
  expect(disabled.composition.summaryBytes).toBe(0);
  expect(disabled.trace.find(row => row.nodeId === summaryNode.id)!.messages).toEqual([]);
  expect(repeated.composition.systemBytes - disabled.composition.systemBytes).toBe(Buffer.byteLength(' / ') + 16);
});
