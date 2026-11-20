import { describe, expect, it } from 'vitest';
import { processActionSuggestions } from './action-suggestions.js';
import { extractCapability } from './parser.js';

const process = (text: string) => processActionSuggestions(extractCapability(text, 'action_suggestions'));
const block = (value: unknown) => '<action_suggestions>' + JSON.stringify(value) + '</action_suggestions>';

describe('independent action suggestions', () => {
  it.each(['正文', '<action_suggestions> \n </action_suggestions>', block([])])('accepts absent or empty output: %s', text => {
    expect(process(text)).toEqual({ status: 'no_suggestions', items: [] });
  });

  it('keeps nonempty suggestions around an empty entry without enforcing a final count of three', () => {
    expect(process(block([' 继续询问。 ', '', '离开酒馆。']))).toEqual({
      status: 'partial_success', items: ['继续询问。', '离开酒馆。'],
    });
    expect(process(block(['仅一个有效选项。']))).toMatchObject({ status: 'success', items: ['仅一个有效选项。'] });
  });

  it('distinguishes an empty array from arrays containing only empty or invalid suggestions', () => {
    expect(process(block(['', '  ']))).toMatchObject({
      status: 'invalid_suggestions', items: [],
    });
    expect(process(block({ items: [] }))).toMatchObject({ status: 'invalid_suggestions', items: [] });
    expect(process('<action_suggestions>["x",]</action_suggestions>')).toMatchObject({ status: 'invalid_json', items: [] });
  });

  it('isolates item type, length and duplicate errors while counting Unicode code points', () => {
    const fifty = '😀'.repeat(50);
    const result = process(block([50, fifty, '😀'.repeat(51), '继续。', '继续。']));
    expect(result.status).toBe('partial_success');
    expect(result.items).toEqual([fifty, '继续。']);
    expect(result).not.toHaveProperty('results');
  });

  it('rejects its own damaged tags while ignoring damaged state tags', () => {
    expect(process(block(['有效。']) + '<action_suggestions>["也有效但未闭合。"]'))
      .toMatchObject({ status: 'invalid_tag', items: [] });
    expect(process('<state_update>\n{"path":"coins","value":\n' + block(['有效。'])))
      .toMatchObject({ status: 'success', items: ['有效。'] });
  });

  it('uses the last valid candidate, preserving earlier valid data across invalid candidates', () => {
    const result = process(block(['早先。']) + '<action_suggestions>broken</action_suggestions>');
    expect(result).toMatchObject({ status: 'partial_success', items: ['早先。'] });
    expect(process(block(['早先。']) + block(['后来。']))).toMatchObject({ status: 'success', items: ['后来。'] });
    expect(process(block(['早先。']) + block([]))).toMatchObject({ status: 'no_suggestions', items: [] });
  });

  it('does not interpret escaped reserved tags as boundaries', () => {
    const result = process('<action_suggestions>["阅读\\u003Cstate_update\\u003E标记。"]</action_suggestions>');
    expect(result).toMatchObject({ status: 'success', items: ['阅读<state_update>标记。'] });
  });
});
