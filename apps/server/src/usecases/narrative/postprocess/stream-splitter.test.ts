import { describe, expect, it } from 'vitest';
import { NarrativeStreamSplitter, splitNarrativeContent } from './stream-splitter.js';

describe('narrative public stream isolation', () => {
  it.each([
    '<state_update>{"path":"coins","value":8}</state_update>',
    '<ACTION_SUGGESTIONS>["继续。"]</ACTION_SUGGESTIONS>',
    '<character_sprite>{"position":"left","characterId":"alice","spriteId":"default"}</character_sprite>',
    '<CHARACTER_SPRITE></CHARACTER_SPRITE>',
    '<character_sprite broken>',
    '</character_sprite>',
    '</state_update>',
    '<state_update broken>{"path":"coins","value":8}',
    '<sr_extensions><state_update>{}</state_update></sr_extensions>',
  ])('hides the complete tail across every possible chunk boundary: %s', tail => {
    const prefix = '故事😀继续。\n';
    const text = prefix + tail + '\n尾部文本也隐藏';
    for (let cut = 0; cut <= text.length; cut++) {
      const splitter = new NarrativeStreamSplitter();
      const actual = splitter.push(text.slice(0, cut)) + splitter.push(text.slice(cut)) + splitter.finish();
      expect(actual).toBe(prefix);
      expect(splitter.tail).toBe(tail + '\n尾部文本也隐藏');
    }
  });

  it('does not shift ASCII tag positions when prose has Unicode case mappings of different lengths', () => {
    expect(splitNarrativeContent('İ故事。<STATE_UPDATE>{}</STATE_UPDATE>'))
      .toEqual({ content: 'İ故事。', tail: '<STATE_UPDATE>{}</STATE_UPDATE>' });
  });

  it.each(['<', '<sta', '<STATE_UPDATE', '</ACTION_SUGG', '<character_spr', '</CHARACTER_SPRITE'])('drops incomplete reserved prefixes: %s', prefix => {
    const splitter = new NarrativeStreamSplitter();
    expect(splitter.push('正文' + prefix) + splitter.finish()).toBe('正文');
    expect(splitter.tail).toBe(prefix);
    expect(splitter.finish()).toBe('');
  });

  it('releases ordinary text and tag-like longer names without hiding', () => {
    const text = '正文 <strong>强调</strong> <state_updates>作者文本</state_updates> <character_sprites>角色</character_sprites> &lt;state_update&gt;';
    const splitter = new NarrativeStreamSplitter();
    let visible = '';
    for (const char of text) visible += splitter.push(char);
    expect(visible + splitter.finish()).toBe(text);
    expect(splitter.tail).toBe('');
  });

  it('does not cut a surrogate pair and finalizes an unfinished surrogate safely', () => {
    const splitter = new NarrativeStreamSplitter();
    expect(splitter.push('前\uD83D')).toBe('前');
    expect(splitter.push('\uDE00后')).toBe('😀后');
    expect(splitter.finish()).toBe('');
    expect(splitNarrativeContent('前\uD83D')).toEqual({ content: '前\uFFFD', tail: '' });
  });

  it('re-splits an authoritative final snapshot independently of earlier streamed content', () => {
    const splitter = new NarrativeStreamSplitter();
    expect(splitter.push('旧正文<state_update>{}</state_update>')).toBe('旧正文');
    expect(splitNarrativeContent('修正正文<ACTION_SUGGESTIONS>[]</ACTION_SUGGESTIONS>'))
      .toEqual({ content: '修正正文', tail: '<ACTION_SUGGESTIONS>[]</ACTION_SUGGESTIONS>' });
  });

  it('applies sprite hiding to the final snapshot even when earlier deltas had no sprite tag', () => {
    const splitter = new NarrativeStreamSplitter();
    expect(splitter.push('原始正文')).toBe('原始正文');
    expect(splitNarrativeContent('修正正文<character_sprite></character_sprite>'))
      .toEqual({ content: '修正正文', tail: '<character_sprite></character_sprite>' });
  });

  it('does not drop a long hidden tail or restore public output', () => {
    const tail = '<state_update>' + 'x'.repeat(270_000) + '</state_update>';
    const splitter = new NarrativeStreamSplitter();
    expect(splitter.push('正文' + tail)).toBe('正文');
    expect(splitter.push('仍是尾部') + splitter.finish()).toBe('');
    expect(splitter.tail).toBe(tail + '仍是尾部');
  });
});
