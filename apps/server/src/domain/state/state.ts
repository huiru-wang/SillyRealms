export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Definition = Record<string, unknown>;
type Scope = 'global' | 'session' | 'message';
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return object(value) && Object.entries(value).every(([key, item]) => !forbidden.has(key) && isJson(item));
}

/** Compile-by-traversal: reject undeclared fields and invalid initial or runtime values. */
export function validateValue(def: Definition, value: unknown, path = '$', depth = 0): asserts value is Json {
  if (depth > 32) fail(path, 'state definition exceeds depth limit');
  if (!['string','number','integer','boolean','enum','object','array','json'].includes(String(def.type))) fail(path, 'unsupported state type');
  if (value === null && def.nullable === true) return;
  switch (def.type) {
    case 'string': if (typeof value !== 'string') fail(path, 'expected string'); break;
    case 'boolean': if (typeof value !== 'boolean') fail(path, 'expected boolean'); break;
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (def.type === 'integer' && !Number.isInteger(value))) fail(path, `expected ${def.type}`);
      if (typeof def.min === 'number' && value < def.min) fail(path, 'below minimum');
      if (typeof def.max === 'number' && value > def.max) fail(path, 'above maximum');
      break;
    case 'enum': if (!Array.isArray(def.values) || !def.values.length || new Set(def.values).size !== def.values.length || !def.values.every(v => typeof v === 'string') || typeof value !== 'string' || !def.values.includes(value)) fail(path, 'invalid enum value'); break;
    case 'json': if (!isJson(value)) fail(path, 'expected JSON'); break;
    case 'array':
      if (!Array.isArray(value) || !object(def.items)) fail(path, 'expected array');
      value.forEach((v, index) => validateValue(def.items as Definition, v, `${path}[${index}]`, depth + 1)); break;
    case 'object': {
      if (!object(value) || !object(def.properties)) fail(path, 'expected object definition and value');
      const keys = Object.keys(def.properties);
      if (keys.some(k => forbidden.has(k)) || Object.keys(value).some(k => !keys.includes(k))) fail(path, 'unknown or unsafe field');
      for (const key of keys) {
        const child = def.properties[key];
        if (!object(child) || !Object.hasOwn(value, key)) fail(`${path}.${key}`, 'missing field or invalid definition');
        validateValue(child, value[key], `${path}.${key}`, depth + 1);
      }
      break;
    }
    default: fail(path, 'unsupported state type');
  }
}

function validateDefinition(root:Definition, path:string):void {
  let count=0;
  const visit=(def:Definition, current:string, itemSchema:boolean, depth:number):void => {
    if (++count>2048 || depth>32) fail(current,'state definition exceeds limits');
    if (!['string','number','integer','boolean','enum','object','array','json'].includes(String(def.type))) fail(current,'unsupported state type');
    if (def.nullable !== undefined && typeof def.nullable !== 'boolean') fail(current,'invalid nullable flag');
    if (def.type === 'number' || def.type === 'integer') {
      if (def.min !== undefined && (typeof def.min !== 'number' || !Number.isFinite(def.min))) fail(current,'invalid minimum');
      if (def.max !== undefined && (typeof def.max !== 'number' || !Number.isFinite(def.max))) fail(current,'invalid maximum');
      if (typeof def.min === 'number' && typeof def.max === 'number' && def.min > def.max) fail(current,'minimum exceeds maximum');
    }
    if (def.type === 'enum' && (!Array.isArray(def.values) || !def.values.length || !def.values.every(v=>typeof v === 'string') || new Set(def.values).size !== def.values.length)) fail(current,'invalid enum definition');
    if (def.type === 'object') {
      if (!object(def.properties)) fail(current,'missing properties');
      for (const [key, child] of Object.entries(def.properties)) {
        if (!key || forbidden.has(key) || !object(child)) fail(current,'invalid field');
        visit(child,`${current}.${key}`,itemSchema,depth+1);
      }
    } else if (def.type === 'array') {
      if (!object(def.items)) fail(current,'invalid array item schema');
      visit(def.items,`${current}[]`,true,depth+1);
    }
    if (def.type !== 'object' && !itemSchema && !Object.hasOwn(def,'initial')) fail(current,'missing initial value');
  };
  visit(root,path,false,0);
}

function initialValue(def: Definition, path: string, depth = 0): Json {
  if (depth > 32) fail(path, 'state definition exceeds depth limit');
  if (def.type === 'object') {
    if (!object(def.properties)) fail(path, 'missing properties');
    const value: Record<string, Json> = Object.create(null);
    for (const [key, child] of Object.entries(def.properties)) {
      if (forbidden.has(key) || !object(child)) fail(path, 'unsafe or invalid field');
      value[key] = initialValue(child, `${path}.${key}`, depth + 1);
    }
    validateValue(def, value, path);
    return value;
  }
  if (!Object.hasOwn(def, 'initial')) fail(path, 'missing initial value');
  validateValue(def, def.initial, path);
  return structuredClone(def.initial);
}

export function initialState(state: unknown, scope: Scope): Record<string, Json> {
  if (state == null) return {};
  if (!object(state) || state.schema_version !== 1 || !object(state.scopes)) fail('state', 'invalid schema');
  if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) fail('state','definition too large');
  const scopeDef = state.scopes[scope];
  if (scopeDef == null) return {};
  if (!object(scopeDef) || !object(scopeDef.modules)) fail(`state.${scope}`, 'invalid modules');
  const result: Record<string, Json> = Object.create(null);
  for (const [key, def] of Object.entries(scopeDef.modules)) {
    if (forbidden.has(key) || !key || !object(def) || def.type !== 'object') fail(`state.${scope}`, 'invalid module');
    validateDefinition(def, `${scope}.${key}`);
    result[key] = initialValue(def, `${scope}.${key}`);
  }
  return result;
}

/** Opening only overlays declared object fields; arrays and JSON are replaced. */
export function applyOpening(state: unknown, initial: Record<string, Json>, override: unknown): Record<string, Json> {
  if (override == null) return initial;
  if (!object(override)) fail('opening.initial_state', 'expected object');
  const stateDef = state as { scopes?: { message?: { modules?: Record<string, Definition> } } } | undefined;
  const modules = stateDef?.scopes?.message?.modules ?? {};
  const result = structuredClone(initial);
  function overlay(def: Definition, current: Json, patch: unknown, path: string): Json {
    if (def.type === 'object') {
      if (!object(patch) || !object(current) || !object(def.properties)) fail(path, 'expected object');
      for (const [key, item] of Object.entries(patch)) {
        const child = def.properties[key];
        if (forbidden.has(key) || !object(child) || !Object.hasOwn(current, key)) fail(`${path}.${key}`, 'unknown field');
        current[key] = overlay(child, current[key] as Json, item, `${path}.${key}`);
      }
      validateValue(def, current, path); return current as Json;
    }
    validateValue(def, patch, path); return structuredClone(patch);
  }
  for (const [key, patch] of Object.entries(override)) {
    const def = modules[key];
    if (!def || !Object.hasOwn(result, key)) fail(`opening.initial_state.${key}`, 'unknown module');
    result[key] = overlay(def, result[key] as Json, patch, `opening.initial_state.${key}`);
  }
  return result;
}

export function validateSnapshot(state: unknown, scope: Scope, value: unknown): asserts value is Record<string, Json> {
  const expected = initialState(state, scope);
  if (!object(value)) fail(scope, 'expected state object');
  const expectedKeys = Object.keys(expected);
  if (Object.keys(value).some(key => !expectedKeys.includes(key)) || expectedKeys.some(key => !Object.hasOwn(value, key))) fail(scope, 'state schema conflict');
  const modules = (state as {scopes?:Partial<Record<Scope,{modules?:Record<string,Definition>}>>} | null)?.scopes?.[scope]?.modules ?? {};
  for (const key of expectedKeys) validateValue(modules[key]!, value[key], `${scope}.${key}`);
}

export function decodeMessageState(text:string):Record<string,Json> {
  const entries:unknown=JSON.parse(text);
  if (!Array.isArray(entries)) fail('message','expected state array');
  const result:Record<string,Json>=Object.create(null);
  for (const entry of entries) {
    if (!object(entry) || typeof entry.key !== 'string' || !entry.key || forbidden.has(entry.key) || Object.hasOwn(result,entry.key) || !Object.hasOwn(entry,'value') || !isJson(entry.value)) fail('message','invalid or duplicate state entry');
    result[entry.key]=entry.value;
  }
  return result;
}
