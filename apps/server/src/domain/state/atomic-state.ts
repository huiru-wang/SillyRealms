import { ErrorCodes } from '../../common/error-codes.js';
import { isDeepStrictEqual } from 'node:util';
import type { Json } from './state.js';

export type AtomicStateDefinition = {
  type: 'string' | 'number' | 'boolean' | 'json';
  initial: Json;
  min?: number;
  max?: number;
  description?: string;
};
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
const validKey = (key: string) => key.length > 0 && !key.includes('.') && !unsafeKeys.has(key);
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validate JSON recursively and forbid keys which cannot be addressed safely. */
export function validateAtomicJson(value: unknown, depth = 0): asserts value is Json {
  if (depth > 32) throw new Error(ErrorCodes.STATE_VALUE_TOO_DEEP);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) validateAtomicJson(item, depth + 1); return; }
  if (isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const [key, item] of Object.entries(value)) {
      if (!validKey(key)) throw new Error(ErrorCodes.INVALID_STATE_KEY);
      validateAtomicJson(item, depth + 1);
    }
    return;
  }
  throw new Error(ErrorCodes.INVALID_STATE_VALUE);
}

export function validateAtomicValue(definition: AtomicStateDefinition, value: unknown): asserts value is Json {
  if (definition.type === 'json') validateAtomicJson(value);
  else if (typeof value !== definition.type || (definition.type === 'number' && !Number.isFinite(value))) throw new Error(ErrorCodes.INVALID_STATE_VALUE);
  if (definition.type === 'number' && typeof value === 'number') {
    if (definition.min !== undefined && value < definition.min || definition.max !== undefined && value > definition.max) throw new Error(ErrorCodes.STATE_OUT_OF_RANGE);
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 1024 * 1024) throw new Error(ErrorCodes.STATE_VALUE_TOO_LARGE);
}

/** Replace a declared field or one existing-parent property in a JSON value. */
export function updateAtomicState(
  values: Record<string, Json>, definitions: Record<string, AtomicStateDefinition>, path: string, value: unknown,
): { changed: boolean; value: Json } {
  const parts = path.split('.');
  if (parts.length > 32 || parts.some(part => !validKey(part))) throw new Error(ErrorCodes.INVALID_STATE_PATH);
  const [root, ...nested] = parts;
  if (!root || !Object.hasOwn(definitions, root) || !Object.hasOwn(values, root)) throw new Error(ErrorCodes.STATE_NOT_FOUND);
  const definition = definitions[root]!;
  if (!nested.length) {
    validateAtomicValue(definition, value);
    const changed = !isDeepStrictEqual(values[root], value);
    if (changed) values[root] = structuredClone(value);
    return { changed, value: structuredClone(value) };
  }
  if (definition.type !== 'json') throw new Error(ErrorCodes.INVALID_STATE_PATH);
  validateAtomicJson(value);
  const copy = structuredClone(values[root]);
  let target: unknown = copy;
  for (const part of nested.slice(0, -1)) {
    if (!isObject(target) || !Object.hasOwn(target, part)) throw new Error(ErrorCodes.INVALID_STATE_PATH);
    target = target[part];
  }
  if (!isObject(target)) throw new Error(ErrorCodes.INVALID_STATE_PATH);
  const key = nested[nested.length - 1]!;
  const changed = !Object.hasOwn(target, key) || !isDeepStrictEqual(target[key], value);
  if (changed) target[key] = structuredClone(value);
  validateAtomicValue(definition, copy);
  if (changed) values[root] = copy as Json;
  return { changed, value: structuredClone(value) };
}

/** Build a scope from its directly declared named fields. */
export function initialAtomicState(definitions: Record<string, AtomicStateDefinition>): Record<string, Json> {
  const values: Record<string, Json> = Object.create(null);
  for (const [name, definition] of Object.entries(definitions)) {
    if (!validKey(name)) throw new Error(ErrorCodes.INVALID_STATE_KEY);
    if (!['string', 'number', 'boolean', 'json'].includes(definition.type)) throw new Error(ErrorCodes.INVALID_STATE_TYPE);
    if (!Object.hasOwn(definition, 'initial')) throw new Error(ErrorCodes.STATE_INITIAL_REQUIRED);
    if (definition.type === 'number') {
      if (definition.min !== undefined && !Number.isFinite(definition.min) || definition.max !== undefined && !Number.isFinite(definition.max)) throw new Error(ErrorCodes.INVALID_STATE_RANGE);
      if (definition.min !== undefined && definition.max !== undefined && definition.min > definition.max) throw new Error(ErrorCodes.INVALID_STATE_RANGE);
    } else if (definition.min !== undefined || definition.max !== undefined) throw new Error(ErrorCodes.INVALID_STATE_RANGE);
    validateAtomicValue(definition, definition.initial);
    values[name] = structuredClone(definition.initial);
  }
  return values;
}

/** Validate the complete committed scope without mutating its values. */
export function validateAtomicSnapshot(definitions: Record<string, AtomicStateDefinition>, value: unknown): asserts value is Record<string, Json> {
  if (!isObject(value)) throw new Error(ErrorCodes.INVALID_STATE_VALUE);
  const expected = Object.keys(definitions);
  if (expected.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !Object.hasOwn(definitions, key))) throw new Error(ErrorCodes.STATE_SCHEMA_MISMATCH);
  for (const key of expected) validateAtomicValue(definitions[key]!, value[key]);
}

export type AtomicScope = 'global' | 'session' | 'message';
export type AtomicUpdate = { path: string; value: unknown; scope?: AtomicScope };
export type AtomicUpdateResult = { path: string; scope: AtomicScope; success: boolean; message: string };
export type AtomicChange = { path: string; scope: AtomicScope; value: Json };

/** Evaluate updates independently, in input order; caller persists before emitting changes. */
export function applyAtomicUpdates(
  values: Record<AtomicScope, Record<string, Json>>,
  definitions: Record<AtomicScope, Record<string, AtomicStateDefinition>>,
  updates: AtomicUpdate[],
): { values: Record<AtomicScope, Record<string, Json>>; results: AtomicUpdateResult[]; changes: AtomicChange[] } {
  const working = structuredClone(values);
  const results: AtomicUpdateResult[] = [];
  const paths: Array<{ path:string; scope:AtomicScope }> = [];
  for (const update of updates) {
    const scope = update.scope ?? 'message';
    try {
      const result = updateAtomicState(working[scope], definitions[scope], update.path, update.value);
      results.push({ path:update.path, scope, success:true, message:'' });
      if (result.changed && !paths.some(item => item.path === update.path && item.scope === scope)) paths.push({ path:update.path, scope });
    } catch (error) {
      results.push({ path:update.path, scope, success:false, message:error instanceof Error ? error.message : 'INVALID_STATE_UPDATE' });
    }
  }
  // Publish only values present in the final snapshot; intermediate working values
  // are not committed facts when the caller persists this batch in one transaction.
  const lookup = (source: Record<string, Json>, path: string): { found:boolean; value?:Json } => {
    let current: unknown = source;
    for (const part of path.split('.')) {
      if (!isObject(current) || !Object.hasOwn(current, part)) return { found:false };
      current = current[part];
    }
    return { found:true, value:current as Json };
  };
  const changes: AtomicChange[] = [];
  for (const item of paths) {
    const before = lookup(values[item.scope], item.path);
    const after = lookup(working[item.scope], item.path);
    if (after.found && (!before.found || !isDeepStrictEqual(before.value, after.value))) changes.push({ ...item, value:structuredClone(after.value!) });
  }
  return { values:working, results, changes };
}
