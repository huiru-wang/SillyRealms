import { expect, it } from 'vitest';
import { parsePromptTemplate } from './prompt-template.js';

it.each(['state.bad.name', 'state.session..name', 'state.global.constructor',
  'state.message.items[0]', 'state.session.' + Array(33).fill('k').join('.')])('isolates invalid path %s', name => {
  const token = '{{' + name + '}}';
  expect(parsePromptTemplate('a' + token + 'b{{user}}', ['user'], 'author'))
    .toEqual([{ type: 'text', value: 'ab' }, { type: 'variable', name: 'user' }]);
  expect(() => parsePromptTemplate(token, ['user'])).toThrow('状态变量路径无效');
});

it('recovers a later author reference without normalizing unknown text or preset-only names', () => {
  const prefix = '\\{{ weather.today }} {{ user }} {{state.session}} {{history.messages}} {{unclosed ';
  expect(parsePromptTemplate(prefix + '{{state.session.人设.姓名}}', ['user'], 'author')).toEqual([
    { type: 'text', value: prefix }, { type: 'state', scope: 'session', parts: ['人设', '姓名'] },
  ]);
});
