import { describe, expect, it } from 'vitest';
import { extractCapability } from './parser.js';

describe('independent capability tag extraction', () => {
  it('distinguishes absent, empty and present tags without imposing case or order', () => {
    expect(extractCapability('正文', 'state_update')).toEqual({ status: 'missing', blocks: [] });
    expect(extractCapability('<STATE_UPDATE> \r\n </state_update>', 'state_update'))
      .toEqual({ status: 'empty', blocks: [' \r\n '] });
    const text = '<ACTION_SUGGESTIONS>[]</action_suggestions><State_Update>{"path":"coins","value":8}</STATE_UPDATE>';
    expect(extractCapability(text, 'state_update'))
      .toEqual({ status: 'present', blocks: ['{"path":"coins","value":8}'] });
    expect(extractCapability(text, 'action_suggestions')).toEqual({ status: 'present', blocks: ['[]'] });
  });

  it.each([
    '<state_update>{"path":"coins","value":8}',
    '{"path":"coins","value":8}</state_update>',
    '<state_update>{"path":"coins","value":8}</state_update',
    '<state_update broken>{"path":"coins","value":8}</state_update>',
    '<state_update><state_update>{}</state_update></state_update>',
    '<state_update>{}</state_update><state_update>',
  ])('rejects all data belonging to damaged own boundaries: %s', text => {
    expect(extractCapability(text, 'state_update')).toEqual({ status: 'invalid_tag', blocks: [] });
  });

  it('does not rescue state rows at another capability start, but still extracts the other capability', () => {
    const text = '<state_update>\n{"path":"coins","value":8}\n' +
      '<ACTION_SUGGESTIONS>["继续询问。","离开。"]</ACTION_SUGGESTIONS>';
    expect(extractCapability(text, 'state_update')).toEqual({ status: 'invalid_tag', blocks: [] });
    expect(extractCapability(text, 'action_suggestions'))
      .toEqual({ status: 'present', blocks: ['["继续询问。","离开。"]'] });
  });

  it('a complete own pair ignores other capability boundaries inside its body', () => {
    const body = '\n{"path":"coins","value":8}\n<action_suggestions>[]</action_suggestions>\n';
    const text = '<state_update>' + body + '</state_update>';
    expect(extractCapability(text, 'state_update')).toEqual({ status: 'present', blocks: [body] });
    expect(extractCapability(text, 'action_suggestions')).toEqual({ status: 'present', blocks: ['[]'] });
  });

  it('extracts repeated complete own blocks in source order', () => {
    const text = '<state_update>{"value":1}</state_update>text<STATE_UPDATE>{"value":2}</STATE_UPDATE>';
    expect(extractCapability(text, 'state_update'))
      .toEqual({ status: 'present', blocks: ['{"value":1}', '{"value":2}'] });
  });

  it('does not guess unknown names or treat longer identifiers as known tags', () => {
    const text = '<state_updates>{}</state_updates><state_updat>{}</state_updat>';
    expect(extractCapability(text, 'state_update')).toEqual({ status: 'missing', blocks: [] });
    expect(() => extractCapability('', 'state_update|.*')).toThrow('INVALID_CAPABILITY_NAME');
  });
});
