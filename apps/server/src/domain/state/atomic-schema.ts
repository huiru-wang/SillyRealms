import { z } from 'zod';
import { isSafeStateKey, StateValidationError, validateStateSchema } from '@sillyrealms/sdk/state-validation';
import { validateWhen } from './when.js';

const name = z.string().refine(isSafeStateKey, 'Invalid state key');
const load = z.object({
  mode:z.enum(['always','on_mention','never']).optional(),
  keywords:z.array(z.string().trim().min(1)).optional(),
  keyword_logic:z.enum(['any','all']).optional(),
  exclude_keywords:z.array(z.string().trim().min(1)).optional(),
  when:z.string().superRefine((value,ctx)=>{try { validateWhen(value); } catch {ctx.addIssue({code:'custom',message:'Unsupported when expression'});}}).optional(),
}).strict().superRefine((rule,ctx)=>{if(rule.mode==='on_mention' && !rule.keywords?.length)ctx.addIssue({code:'custom',path:['keywords'],message:'Expected at least one keyword'});});
const definition = z.object({
  type:z.enum(['string','number','boolean','json']),
  initial:z.unknown(),
  description:z.string().refine(value => value.trim().length > 0, 'Expected a non-empty description'),
  // Preserve raw keys: z.record silently omits __proto__ before semantic validation.
  rules:z.custom<Record<string,string>>(),
  min:z.number().optional(),
  max:z.number().optional(),
  load:load.optional(),
}).strict();
const scope = z.record(name,definition);
export const atomicStateSchema = z.object({
  schema_version:z.literal(2),
  scopes:z.object({global:scope.optional(),session:scope.optional(),message:scope.optional()}).strict(),
}).strict().superRefine((state,ctx)=>{
  try { validateStateSchema(state); }
  catch (error) {
    if (!(error instanceof StateValidationError)) throw error;
    const roots = state.scopes[error.scope] ?? {};
    const root = Object.keys(roots).find(key => error.path === key || error.path.startsWith(key + '.') || error.path.startsWith(key + '['));
    let path: string[] = [];
    if (root !== undefined) {
      path = ['scopes', error.scope, root];
      if (error.rulePath !== undefined) path.push('rules', error.rulePath);
      else {
        const suffix = error.path.slice(root.length + 1);
        if (['type', 'description', 'min', 'max', 'rules'].includes(suffix)) path.push(suffix);
        else if (suffix.startsWith('load.')) path.push(...suffix.split('.'));
        else path.push('initial');
      }
    }
    ctx.addIssue({ code:'custom', path, message:error.message, params:{ stateDiagnostic:error.details } });
  }
});
