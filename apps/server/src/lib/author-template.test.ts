import { describe, expect, it, vi } from 'vitest';
import { StateService, type StateViews } from '../modules/state/service.js';
import { AuthorTemplateError, parseAuthorTemplate, renderAuthorTemplate } from './author-template.js';

const state = (message: StateViews['message'] = {}): StateViews => ({ global: {}, session: {}, message });
const render = (source: string, views = state()) => renderAuthorTemplate(parseAuthorTemplate(source), {
  evaluateCondition: expression => StateService.prototype.evaluateWhen(expression, views),
  renderText: text => text,
});

function templateError(action: () => unknown): AuthorTemplateError {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(AuthorTemplateError);
    return error as AuthorTemplateError;
  }
  throw new Error('Expected an author template error');
}

describe('author conditional templates', () => {
  it('keeps plain text, whitespace and all interpolation syntax for the text renderer', () => {
    const source = '\n你好 {{user}} {{ state.message.affinity }} {{custom.name}} {{unclosed\n<% arbitrary text %>';
    expect(render(source)).toBe(source);
    const renderText = vi.fn((text: string) => text);
    expect(renderAuthorTemplate(parseAuthorTemplate(''), { evaluateCondition: () => false, renderText })).toBe('');
    expect(renderText).not.toHaveBeenCalled();
  });

  it.each([
    [0, 'guarded'],
    [59, 'guarded'],
    [60, 'trusted'],
    [89, 'trusted'],
    [90, 'close'],
  ])('chooses the first matching if/elif/else branch for affinity %s', (affinity, expected) => {
    const source = "{% if getState('affinity', {scope: 'message'}) >= 90 %}close"
      + "{% elif getState('affinity', {scope: 'message'}) >= 60 %}trusted"
      + '{% else %}guarded{% endif %}';
    expect(render(source, state({ affinity }))).toBe(expected);
  });

  it('renders independent blocks, nested blocks, and an omitted else', () => {
    const source = "A{% if getState('trusted') %}T{% if getState('injured') %}I{% else %}H{% endif %}"
      + "{% else %}G{% endif %}B{% if getState('injured') %}slow{% endif %}C";
    expect(render(source, state({ trusted: true, injured: true }))).toBe('ATIBslowC');
    expect(render(source, state({ trusted: true, injured: false }))).toBe('ATHBC');
    expect(render(source, state({ trusted: false, injured: true }))).toBe('AGBslowC');
  });

  it('never evaluates later conditions or renders text in branches that were not selected', () => {
    const evaluateCondition = vi.fn((expression: string) => {
      if (expression === 'true') return true;
      throw new Error('An inactive condition was evaluated');
    });
    const renderText = vi.fn((text: string) => {
      if (text.includes('hidden')) throw new Error('An inactive text was rendered');
      return text;
    });
    const source = '{% if true %}visible{% elif getState("missing") > 0 %}hidden'
      + '{% else %}{% if getState("missing") %}hidden{% endif %}{% endif %}';
    expect(renderAuthorTemplate(parseAuthorTemplate(source), { evaluateCondition, renderText })).toBe('visible');
    expect(evaluateCondition).toHaveBeenCalledExactlyOnceWith('true');
    expect(renderText).toHaveBeenCalledExactlyOnceWith('visible');
  });

  it('does not evaluate a nested condition inside a false branch', () => {
    const evaluateCondition = vi.fn((expression: string) => {
      if (expression === 'false') return false;
      throw new Error('The nested condition must remain inactive');
    });
    const source = '{% if false %}{% if getState("missing") %}hidden{% endif %}{% else %}shown{% endif %}';
    expect(renderAuthorTemplate(parseAuthorTemplate(source), { evaluateCondition, renderText: text => text })).toBe('shown');
    expect(evaluateCondition).toHaveBeenCalledExactlyOnceWith('false');
  });

  it('does not reparse interpolated data or text assembled across branch boundaries', () => {
    const inserted = '{% if false %}data{% endif %} {{user}}';
    const evaluateCondition = vi.fn(() => true);
    const renderText = vi.fn((text: string) => text.replace('{{state.message.note}}', inserted));
    const source = '{% if true %}{{state.message.note}}{% endif %}';
    expect(renderAuthorTemplate(parseAuthorTemplate(source), { evaluateCondition, renderText })).toBe(inserted);
    expect(evaluateCondition).toHaveBeenCalledOnce();
    expect(renderText).toHaveBeenCalledExactlyOnceWith('{{state.message.note}}');
    expect(renderAuthorTemplate(parseAuthorTemplate('{{sta{% if true %}te.message.note{% endif %}' + '}}'), {
      evaluateCondition, renderText,
    })).toBe('{{state.message.note}}');
  });

  it('supports escaped literal opening markers without rescanning them', () => {
    const source = '\\{% if invalid.code() %}literal\\{% else %}other\\{% endif %} C:\\data {{custom}}';
    const evaluateCondition = vi.fn(() => true);
    expect(renderAuthorTemplate(parseAuthorTemplate(source), { evaluateCondition, renderText: text => text }))
      .toBe('{% if invalid.code() %}literal{% else %}other{% endif %} C:\\data {{custom}}');
    expect(evaluateCondition).not.toHaveBeenCalled();
  });

  it.each(['%}', "it's %}", 'quoted " %}', 'backslash \\ %}', '{% if true %}'])(
    'does not close a directive at a delimiter inside the quoted value %s', marker => {
      const source = "{% if getState('marker', {scope: 'message'}) === " + JSON.stringify(marker)
        + ' %}matched{% else %}missed{% endif %}';
      expect(render(source, state({ marker }))).toBe('matched');
    },
  );

  it('recognizes an escaped quote inside a single-quoted condition string', () => {
    const source = "{% if getState('marker') === 'it\\'s %}' %}matched{% endif %}";
    expect(render(source, state({ marker: "it's %}" }))).toBe('matched');
  });

  it('uses the existing read-only condition contract and preserves state and parsed templates', () => {
    const views = state({ affinity: 70, injury: false });
    Object.freeze(views.global);
    Object.freeze(views.session);
    Object.freeze(views.message);
    Object.freeze(views);
    const source = "{% if getState('affinity', {scope: 'message'}) >= 60 && !getState('injury') %}trusted{% else %}guarded{% endif %}";
    const parsed = parseAuthorTemplate(source);
    const before = structuredClone(parsed);
    const context = {
      evaluateCondition: (expression: string) => StateService.prototype.evaluateWhen(expression, views),
      renderText: (text: string) => text,
    };
    expect(renderAuthorTemplate(parsed, context)).toBe('trusted');
    expect(renderAuthorTemplate(parsed, context)).toBe('trusted');
    expect(parsed).toEqual(before);
    expect(views).toEqual(state({ affinity: 70, injury: false }));
  });

  it('allows an explicit missing-state fallback without treating errors as false', () => {
    expect(render("{% if (getState('missing') ?? 0) >= 60 %}trusted{% else %}guarded{% endif %}")).toBe('guarded');
    const error = templateError(() => render("{% if getState('missing') >= 60 %}trusted{% else %}guarded{% endif %}"));
    expect(error).toMatchObject({ kind: 'evaluation', line: 1, column: 1 });
  });

  it('reports an evaluation failure at its original elif position and omits exception details', () => {
    const source = 'heading\n{% if false %}first\n  {% elif getState("missing") %}second\n{% else %}fallback{% endif %}';
    const renderText = vi.fn((text: string) => text);
    const error = templateError(() => renderAuthorTemplate(parseAuthorTemplate(source), {
      evaluateCondition: expression => {
        if (expression === 'false') return false;
        throw new Error('secret state value: 9001');
      },
      renderText,
    }));
    expect(error).toMatchObject({ kind: 'evaluation', line: 3, column: 3 });
    expect(error.message).not.toContain('9001');
    expect(error.message).not.toContain('missing');
    expect(renderText.mock.calls.some(([text]) => text.includes('fallback'))).toBe(false);
  });

  it('rejects a condition callback that returns a non-boolean', () => {
    const error = templateError(() => renderAuthorTemplate(parseAuthorTemplate('{% if true %}yes{% else %}no{% endif %}'), {
      evaluateCondition: () => 1 as unknown as boolean,
      renderText: text => text,
    }));
    expect(error.kind).toBe('evaluation');
  });

  it.each([
    '{% elif true %}',
    '{% else %}',
    '{% endif %}',
    '{% if %}yes{% endif %}',
    '{% if true %}',
    '{% if true',
    '{% if "unterminated %}yes{% endif %}',
    '{% if true %}yes{% elif %}no{% endif %}',
    '{% if true %}yes{% else true %}no{% endif %}',
    '{% if true %}yes{% endif true %}',
    '{% if true %}yes{% else %}no{% else %}again{% endif %}',
    '{% if true %}yes{% else %}no{% elif true %}late{% endif %}',
    '{% for item in items %}no{% endif %}',
    '{% if(true) %}yes{% endif %}',
  ])('rejects malformed conditional structure: %s', source => {
    expect(templateError(() => parseAuthorTemplate(source)).kind).toBe('syntax');
  });

  it.each([
    'process.exit()',
    'getState("affinity") = 100',
    'setState("affinity", 100)',
    'getState("profile").name === "secret"',
    '(() => true)()',
    'getState("affinity", {scope: "other"}) > 0',
  ])('rejects expressions outside the existing when grammar: %s', expression => {
    const error = templateError(() => parseAuthorTemplate('first\n  {% if ' + expression + ' %}text{% endif %}'));
    expect(error).toMatchObject({ kind: 'syntax', line: 2, column: 3 });
    expect(error.message).not.toContain(expression);
  });

  it.each(['\n', '\r\n', '\r'])('reports directive positions with %j line endings', newline => {
    expect(templateError(() => parseAuthorTemplate('first' + newline + '  {% else %}')))
      .toMatchObject({ kind: 'syntax', line: 2, column: 3 });
    expect(templateError(() => parseAuthorTemplate('first' + newline + '  {% if true %}text')))
      .toMatchObject({ kind: 'syntax', line: 2, column: 3 });
  });

  it('validates expressions in branches that will be inactive at render time', () => {
    const source = '{% if false %}{% if process.exit() %}hidden{% endif %}{% endif %}';
    expect(templateError(() => parseAuthorTemplate(source)).kind).toBe('syntax');
  });

  it('accepts 32 nested conditions and rejects the thirty-third', () => {
    const nested = (depth: number) => '{% if true %}'.repeat(depth) + 'ok' + '{% endif %}'.repeat(depth);
    expect(render(nested(32))).toBe('ok');
    expect(templateError(() => parseAuthorTemplate(nested(33))).message).toContain('32');
  });

  it('bounds total if and elif conditions at 256', () => {
    const blocks = '{% if true %}x{% endif %}';
    expect(render(blocks.repeat(256))).toBe('x'.repeat(256));
    expect(templateError(() => parseAuthorTemplate(blocks.repeat(257))).message).toContain('256');
    const branches = (count: number) => '{% if false %}x' + '{% elif false %}x'.repeat(count - 1) + '{% else %}ok{% endif %}';
    expect(render(branches(256))).toBe('ok');
    expect(templateError(() => parseAuthorTemplate(branches(257))).message).toContain('256');
  });
});
