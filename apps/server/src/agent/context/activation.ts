import { evaluateWhen, validateWhen } from '../../domain/state/when.js';

type Views = Record<'global'|'session'|'message', Record<string, unknown>>;
type Rule = { mode?: 'always'|'on_mention'|'never'; keywords?: string[]; keyword_logic?: 'any'|'all'; exclude_keywords?: string[]; when?: string };
export function evaluateLoad(rule: Rule = {}, messages: string[], state: Views): { active:boolean; reason:string; details:{mode:string;keywordLogic:string;keywords:Array<{keyword:string;matched:boolean}>;excluded:Array<{keyword:string;matched:boolean}>;when:string|null;whenResult:boolean|null} } {
  const details={mode:rule.mode??'always',keywordLogic:rule.keyword_logic??'any',keywords:[] as Array<{keyword:string;matched:boolean}>,excluded:[] as Array<{keyword:string;matched:boolean}>,when:rule.when??null,whenResult:null as boolean|null};
  const result=(active:boolean,reason:string)=>({active,reason,details});
  try {
    const mode=details.mode;
    if (mode === 'never') return result(false,'never');
    if (mode !== 'always' && mode !== 'on_mention') return result(false,'invalid_rule');
    if (rule.when !== undefined) validateWhen(rule.when);
    if (mode === 'on_mention') {
      if (!rule.keywords?.length || rule.keywords.some(k => !k) || (rule.keyword_logic && !['any','all'].includes(rule.keyword_logic))) return result(false,'invalid_rule');
      const match=(keyword:string)=>messages.some(text=>text.includes(keyword));
      details.keywords=rule.keywords.map(keyword=>({keyword,matched:match(keyword)}));
      details.excluded=(rule.exclude_keywords??[]).map(keyword=>({keyword,matched:match(keyword)}));
      if (details.excluded.some(item=>item.matched)) return result(false,'excluded');
      if (!(rule.keyword_logic === 'all' ? details.keywords.every(item=>item.matched) : details.keywords.some(item=>item.matched))) return result(false,'keyword_unmatched');
    }
    if (rule.when) { details.whenResult=evaluateWhen(rule.when,state); if (!details.whenResult) return result(false,'when_false'); }
    return result(true,'matched');
  } catch { return result(false,'when_evaluation_failed'); }
}
