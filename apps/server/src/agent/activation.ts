import { evaluateWhen, validateWhen } from '../domain/state/when.js';

type Views = Record<'global'|'session'|'message', Record<string, unknown>>;
type Rule = { mode?: 'always'|'on_mention'; keywords?: string[]; keyword_logic?: 'any'|'all'; exclude_keywords?: string[]; when?: string };
export function evaluateLoad(rule: Rule = {}, messages: string[], state: Views): { active: boolean; reason: string } {
  try {
    const mode = rule.mode ?? 'always';
    if (mode !== 'always' && mode !== 'on_mention') return { active: false, reason: 'invalid_rule' };
    if (rule.when !== undefined) validateWhen(rule.when);
    if (mode === 'on_mention') {
      if (!rule.keywords?.length || rule.keywords.some(k => !k) || (rule.keyword_logic && !['any','all'].includes(rule.keyword_logic))) return { active: false, reason: 'invalid_rule' };
      const match = (keyword: string) => messages.some(text => text.includes(keyword));
      if (rule.exclude_keywords?.some(match)) return { active: false, reason: 'excluded' };
      if (!(rule.keyword_logic === 'all' ? rule.keywords.every(match) : rule.keywords.some(match))) return { active: false, reason: 'keyword_unmatched' };
    }
    if (rule.when && !evaluateWhen(rule.when, state)) return { active: false, reason: 'when_false' };
    return { active: true, reason: 'matched' };
  } catch { return { active: false, reason: 'invalid_rule' }; }
}
