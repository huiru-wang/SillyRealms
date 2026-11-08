import { z } from 'zod';
import { validateWhen } from './when.js';
import { initialAtomicState, type AtomicStateDefinition } from './atomic-state.js';

const name=z.string().min(1).refine(value=>!value.includes('.') && !['__proto__','prototype','constructor'].includes(value),'Invalid state key');
const load=z.object({
  mode:z.enum(['always','on_mention','never']).optional(),
  keywords:z.array(z.string().trim().min(1)).optional(),
  keyword_logic:z.enum(['any','all']).optional(),
  exclude_keywords:z.array(z.string().trim().min(1)).optional(),
  when:z.string().superRefine((value,ctx)=>{try { validateWhen(value); } catch {ctx.addIssue({code:'custom',message:'Unsupported when expression'});}}).optional(),
}).strict().superRefine((rule,ctx)=>{if(rule.mode==='on_mention' && !rule.keywords?.length)ctx.addIssue({code:'custom',path:['keywords'],message:'Expected at least one keyword'});});
const definition=z.object({
  type:z.enum(['string','number','boolean','json']),
  initial:z.unknown(),
  description:z.string().optional(),
  min:z.number().optional(),
  max:z.number().optional(),
  load:load.optional(),
}).strict();
const scope=z.record(name,definition);
export const atomicStateSchema=z.object({
  schema_version:z.literal(1),
  scopes:z.object({global:scope.optional(),session:scope.optional(),message:scope.optional()}).strict(),
}).strict().superRefine((state,ctx)=>{
  for(const [scopeName,definitions] of Object.entries(state.scopes)) {
    try { initialAtomicState(definitions as Record<string,AtomicStateDefinition>); }
    catch(error) {ctx.addIssue({code:'custom',path:['scopes',scopeName],message:error instanceof Error?error.message:'INVALID_STATE'});}
  }
});
