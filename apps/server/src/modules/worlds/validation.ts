import { z } from 'zod';
import { isReleaseVersion } from '@sillyrealms/sdk/release-version';
import type { WorldPublication } from './types.js';
import { validateWhen } from '@sillyrealms/sdk/when-expression';
import { parseSRAssetUri } from '@sillyrealms/sdk/assets';
import {
  isSafeStateKey, validateStateJson, validateStateSchema, validateStateValue,
  type StateSchema,
} from '@sillyrealms/sdk/state-validation';
import { AppError } from '../../errors.js';
import type { JsonObject, JsonValue } from '../../infrastructure/database/connection.js';


const atomicStateSchema = z.custom<StateSchema>((value) => value !== null && typeof value === 'object');
const nonblank=z.string().refine(v=>v.trim().length>0,'Expected nonempty text');
const id=z.string().trim().min(1);
const dict=z.record(z.string(),z.unknown());
const condition=z.string().superRefine((value,ctx)=>{
  try {validateWhen(value);} catch {ctx.addIssue({code:'custom',message:'Unsupported when expression'});}
});
const rules={
  mode:z.enum(['always','on_mention','never']).optional(), keywords:z.array(nonblank).optional(),
  keyword_logic:z.enum(['any','all']).optional(), exclude_keywords:z.array(nonblank).optional(), when:condition.optional(),
};
function keywords(rule:{mode?:string;keywords?:string[]},ctx:z.RefinementCtx) {
  if(rule.mode==='on_mention' && !rule.keywords?.length) ctx.addIssue({code:'custom',path:['keywords'],message:'Expected at least one keyword'});
}
const load=z.object(rules).superRefine(keywords);
const loreLoad=z.object({...rules,order:z.number().int().optional()}).superRefine(keywords);
const spriteAsset = nonblank.superRefine((value, ctx) => {
  try {
    if (/^sr-asset:/i.test(value)) parseSRAssetUri(value, 'assets');
    else {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !/^https?:\/\//i.test(value)) throw new Error('Unsupported asset protocol');
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected an HTTP(S) URL or sr-asset://assets/ package path' });
  }
});
const sprite = z.object({ id, asset: spriteAsset, description: nonblank }).strict();
const sprites = z.array(sprite).superRefine(unique).superRefine((items, ctx) => {
  if (items.length && !items.some(item => item.id === 'default')) {
    ctx.addIssue({ code: 'custom', message: 'Nonempty sprites must contain default' });
  }
});
const componentId=z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$-]*$/);
const componentView=z.object({type:z.literal('component'),component:componentId}).strict();
const presentationSchema=z.discriminatedUnion('type', [
  z.object({type:z.literal('markdown'),text:nonblank.refine(value=>Buffer.byteLength(value,'utf8')<=100000,'Exceeds 100000 bytes')}).strict(),
  componentView,
]);
const character=z.object({id,name:nonblank,presentation:presentationSchema.optional(),content:z.string().optional(),avatar:z.string().optional(),order:z.number().int().optional(),player_selectable:z.boolean().optional(),load:load.optional(),sprites:sprites.optional()}).strict();
export const openingSchema=z.object({id,name:nonblank,content:nonblank,initial_state:dict.optional(),presentation:presentationSchema.optional()}).strict();
const lore=z.object({id,title:z.string().optional(),content:nonblank,enabled:z.boolean().optional(),load:loreLoad.optional()});
function unique(items:{id:string}[],ctx:z.RefinementCtx) {
  const seen=new Set<string>();
  items.forEach((item,i)=>{if(seen.has(item.id)) ctx.addIssue({code:'custom',path:[i,'id'],message:'Duplicate ID'}); seen.add(item.id);});
}
const characters = z.array(character).superRefine(unique)
  .refine(items => items.some(item => item.player_selectable === true), 'Expected a selectable player character');
const boundedBytes=(limit:number)=>z.string().refine(value=>Buffer.byteLength(value,'utf8')<=limit,`Exceeds ${limit} bytes`);
const renderRule=z.object({
  id,
  name:z.string().optional(),
  roles:z.array(z.enum(['user','assistant'])).min(1),
  pattern:z.string().min(1).max(2000),
  flags:z.string().optional(),
  replacement:z.discriminatedUnion('type',[
    z.object({type:z.literal('markdown'),text:boundedBytes(100000)}).strict(),
    z.object({type:z.literal('html'),text:boundedBytes(100000)}).strict(),
    z.object({type:z.literal('component'),component:componentId}).strict(),
  ]),
}).strict().superRefine((rule,ctx)=>{
  const flags=rule.flags??'g';
  if(!/^[gimsu]*$/.test(flags) || new Set(flags).size!==flags.length) {
    ctx.addIssue({code:'custom',path:['flags'],message:'Invalid regular expression flags'});return;
  }
  try {new RegExp(rule.pattern,flags);} catch {ctx.addIssue({code:'custom',path:['pattern'],message:'Invalid regular expression'});}
});
const messageRender=z.object({
  rules:z.array(renderRule).max(100).superRefine(unique).optional(),
}).strict();
const componentPath=z.string().superRefine((value,ctx)=>{
  try {parseSRAssetUri(value,'components');} catch {ctx.addIssue({code:'custom',message:'Expected an sr-asset://components/ package path'});}
});
const componentSource=z.object({
  id:componentId,
  path:componentPath.optional(),
  component:boundedBytes(1024*1024).optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.path===undefined && !value.component?.trim())ctx.addIssue({code:'custom',message:'Expected path or nonempty component'});
});
const components=z.array(componentSource).max(100).superRefine(unique).superRefine((value,ctx)=>{
  if(value.reduce((total,item)=>total+Buffer.byteLength(item.component??'','utf8'),0)>2*1024*1024)ctx.addIssue({code:'custom',message:'Components exceed 2 MiB'});
});
const extensions = z.custom<Record<string, unknown>>(
  value => value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected extension object',
).superRefine((value, ctx) => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.hasOwn(value, 'cover_mosaic_enabled') && typeof value.cover_mosaic_enabled !== 'boolean') {
    ctx.addIssue({ code: 'custom', path: ['cover_mosaic_enabled'], message: 'Expected boolean' });
  }
});
function publicationUrl(protocols: readonly string[], update = false) {
  return z.string().refine(value => {
    try {
      const url = new URL(value);
      return value === value.trim() && /^https?:\/\//i.test(value) && protocols.includes(url.protocol)
        && !url.username && !url.password && (!update || !url.hash);
    } catch { return false; }
  }, update ? 'Expected an absolute HTTPS update URL without credentials or fragment' : 'Expected an absolute HTTP(S) URL');
}
const publicationSchema = z.object({
  package_id: z.uuid().regex(/^[0-9a-f-]+$/, 'Expected a canonical lowercase UUID'),
  authors: z.array(z.object({ name: nonblank, url: publicationUrl(['http:', 'https:']).optional() }).strict()).min(1),
  creator_notes: z.string().optional(),
  release: z.object({
    version: z.string().refine(isReleaseVersion, 'Expected a stable MAJOR.MINOR.PATCH version'),
    published_at: z.iso.datetime({ offset: true }),
    notes: z.string(),
  }).strict(),
  homepage: publicationUrl(['http:', 'https:']).optional(),
  update_url: publicationUrl(['https:'], true).optional(),
}).strict();
const schema=z.object({spec_version:z.literal('0.2'),data:z.object({
  publication: publicationSchema,
  name:id,presentation:presentationSchema.optional(),tags:z.array(id).optional(),cover:z.string().optional(),
  characters,
  openings:z.array(openingSchema).min(1).superRefine(unique),state:atomicStateSchema.optional(),
  lorebook:z.object({entries:z.array(lore).superRefine(unique)}).optional(),message_render:messageRender.optional(),ui:z.never().optional(),components:components.optional(),stage_component:componentId.optional(),extensions:extensions.optional()
}).strict()}).strict();

export type WorldCard = z.infer<typeof schema>;

export class CardError extends AppError {
  constructor(readonly path: string, readonly reason: string) {
    super('INVALID_WORLD_CARD', path + ': ' + reason);
  }
}

function location(parts: PropertyKey[]): string {
  return parts.reduce<string>((path, part) => path + (typeof part === 'number' ? '[' + part + ']' : '.' + String(part)), '$');
}

export function validateWorldStateDefinition(value: unknown): asserts value is StateSchema {
  try {
    validateStateSchema(value);
    for (const scope of ['global', 'session', 'message'] as const) {
      for (const definition of Object.values(value.scopes[scope] ?? {})) {
        if (definition.load?.when !== undefined) validateWhen(definition.load.when);
      }
    }
  } catch (error) {
    throw new CardError('$.data.state', error instanceof Error ? error.message : 'Invalid state definition');
  }
}

/** Validate the author protocol and references without executing narrative rules. */
export function validateCard(raw: unknown): WorldCard {
  function depth(value: unknown, level: number): void {
    if (level > 64) throw new CardError('$', 'World exceeds maximum depth');
    if (value && typeof value === 'object') for (const child of Object.values(value)) depth(child, level + 1);
  }
  depth(raw, 0);
  const rawState = (raw as { data?: { state?: unknown } } | null)?.data?.state;
  if (rawState !== undefined) validateWorldStateDefinition(rawState);
  const openings = (raw as { data?: { openings?: unknown } } | null)?.data?.openings;
  if (Array.isArray(openings)) openings.forEach((opening, index) => {
    if (opening && typeof opening === 'object' && 'initial_state' in opening) {
      try { validateStateJson(opening.initial_state); }
      catch (error) {
        throw new CardError('$.data.openings[' + index + '].initial_state', error instanceof Error ? error.message : 'Invalid initial value');
      }
    }
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new CardError(location(issue.path), issue.message);
  }
  const card = parsed.data;
  const components = new Set(card.data.components?.map(component => component.id));
  const reference = (id: string | undefined, path: string) => {
    if (id !== undefined && !components.has(id)) throw new CardError(path, 'Component not found');
  };
  const presentationReference = (value: z.infer<typeof presentationSchema> | undefined, path: string) => {
    if (value?.type === 'component') reference(value.component, path + '.component');
  };
  presentationReference(card.data.presentation, '$.data.presentation');
  card.data.characters.forEach((character, index) => {
    presentationReference(character.presentation, '$.data.characters[' + index + '].presentation');
  });
  reference(card.data.stage_component, '$.data.stage_component');
  card.data.openings.forEach((opening, index) => {
    const path = '$.data.openings[' + index + ']';
    presentationReference(opening.presentation, path + '.presentation');
    for (const [key, value] of Object.entries(opening.initial_state ?? {})) {
      if (!isSafeStateKey(key)) throw new CardError(path + '.initial_state.' + key, 'Unsafe state key');
      const definition = card.data.state?.scopes.message?.[key];
      if (!definition) throw new CardError(path + '.initial_state.' + key, 'State root not found');
      try { validateStateValue(definition, value, key, 'message'); }
      catch (error) { throw new CardError(path + '.initial_state.' + key, error instanceof Error ? error.message : 'Invalid initial value'); }
    }
  });
  card.data.message_render?.rules?.forEach((rule, index) => {
    if (rule.replacement.type === 'component') reference(rule.replacement.component, '$.data.message_render.rules[' + index + '].replacement.component');
  });
  return card;
}

export function validateWorldExtensions(value: JsonValue): asserts value is JsonObject {
  const result = extensions.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new CardError(location(['data', 'extensions', ...issue.path]), issue.message);
  }
}

export function validateCharacters(value: unknown): WorldCard['data']['characters'] {
  const result = characters.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new CardError(location(['data', 'characters', ...issue.path]), issue.message);
  }
  return result.data;
}

export function validateComponents(value: unknown) { return components.parse(value); }

export function validateWorldPublication(value: unknown): WorldPublication {
  const result = publicationSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new CardError(location(['data', 'publication', ...issue.path]), issue.message);
  }
  return result.data;
}
