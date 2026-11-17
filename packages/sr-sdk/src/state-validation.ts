/** Browser-safe state v2 validation shared by authoring and the server. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type StateScope = 'global' | 'session' | 'message';
export type StateDefinition = {
  type: 'string' | 'number' | 'boolean' | 'json';
  initial: Json;
  description: string;
  rules: Record<string, string>;
  min?: number;
  max?: number;
  load?: {
    mode?: 'always' | 'on_mention' | 'never';
    keywords?: string[];
    keyword_logic?: 'any' | 'all';
    exclude_keywords?: string[];
    when?: string;
  };
};
export type StateSchema = {
  schema_version: 2;
  scopes: Partial<Record<StateScope, Record<string, StateDefinition>>>;
};
export type StateValidationCode =
  | 'INVALID_STATE' | 'INVALID_STATE_KEY' | 'INVALID_STATE_TYPE'
  | 'STATE_INITIAL_REQUIRED' | 'INVALID_STATE_RANGE' | 'INVALID_STATE_VALUE'
  | 'STATE_OUT_OF_RANGE' | 'STATE_VALUE_TOO_LARGE' | 'STATE_VALUE_TOO_DEEP'
  | 'STATE_SCHEMA_MISMATCH' | 'INVALID_STATE_PATH' | 'STATE_NOT_FOUND'
  | 'STATE_ROOT_NOT_ACTIVE' | 'STATE_RULE_MISSING' | 'INVALID_STATE_RULE_PATH';
export type StateDiagnostic = {
  code: StateValidationCode;
  scope: StateScope;
  path: string;
  rulePath?: string;
};

export class StateValidationError extends Error {
  readonly code: StateValidationCode;
  readonly scope: StateScope;
  readonly path: string;
  readonly rulePath?: string;
  readonly details: StateDiagnostic;

  constructor(code: StateValidationCode, scope: StateScope = 'message', path = '', rulePath?: string) {
    super(code + ': ' + scope + (path ? '.' + path : ''));
    this.name = 'StateValidationError';
    this.code = code;
    this.scope = scope;
    this.path = path;
    this.rulePath = rulePath;
    this.details = { code, scope, path, ...(rulePath === undefined ? {} : { rulePath }) };
  }
}

export const STATE_MAX_BYTES = 1024 * 1024;
export const STATE_MAX_DEPTH = 32;
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const scopes: readonly StateScope[] = ['global', 'session', 'message'];
const encoder = new TextEncoder();

export function isSafeStateKey(key: string): boolean {
  return key.length > 0 && !key.includes('.') && !key.includes('[') && !key.includes(']') && !unsafeKeys.has(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function fail(code: StateValidationCode, scope: StateScope, path: string, rulePath?: string): never {
  throw new StateValidationError(code, scope, path, rulePath);
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[], scope: StateScope, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('INVALID_STATE', scope, path ? path + '.' + key : key);
  }
}

function checkSize(value: unknown, scope: StateScope, path: string): void {
  if (encoder.encode(JSON.stringify(value)).byteLength > STATE_MAX_BYTES) fail('STATE_VALUE_TOO_LARGE', scope, path);
}

function checkJson(value: unknown, depth: number, scope: StateScope, path: string): asserts value is Json {
  if (depth > STATE_MAX_DEPTH) fail('STATE_VALUE_TOO_DEEP', scope, path);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) checkJson(value[index], depth + 1, scope, path + '[' + index + ']');
    return;
  }
  if (isRecord(value)) {
    if (Object.getOwnPropertySymbols(value).length) fail('INVALID_STATE_VALUE', scope, path);
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? path + '.' + key : key;
      if (!isSafeStateKey(key)) fail('INVALID_STATE_KEY', scope, childPath);
      checkJson(child, depth + 1, scope, childPath);
    }
    return;
  }
  fail('INVALID_STATE_VALUE', scope, path);
}

/** Root depth is zero; each object property or array element adds one level. */
export function validateStateJson(value: unknown, depth = 0, scope: StateScope = 'message', path = ''): asserts value is Json {
  checkJson(value, depth, scope, path);
}

function checkRulePath(root: string, path: string, scope: StateScope): void {
  let offset = 0;
  const segment = (): string => {
    const start = offset;
    while (offset < path.length && !'.[]'.includes(path[offset]!)) offset++;
    const name = path.slice(start, offset);
    if (!isSafeStateKey(name)) fail('INVALID_STATE_RULE_PATH', scope, root + '.rules.' + path, path);
    return name;
  };
  if (segment() !== root) fail('INVALID_STATE_RULE_PATH', scope, root + '.rules.' + path, path);
  while (offset < path.length) {
    if (path.startsWith('[]', offset)) offset += 2;
    else if (path[offset] === '.') { offset++; segment(); }
    else fail('INVALID_STATE_RULE_PATH', scope, root + '.rules.' + path, path);
  }
}

function checkRules(root: string, rules: unknown, scope: StateScope): asserts rules is Record<string, string> {
  if (!isRecord(rules)) fail('INVALID_STATE', scope, root + '.rules');
  for (const [path, text] of Object.entries(rules)) {
    checkRulePath(root, path, scope);
    if (typeof text !== 'string') fail('INVALID_STATE', scope, root + '.rules.' + path);
    if (!text.trim()) fail('STATE_RULE_MISSING', scope, path, path);
  }
  if (!Object.hasOwn(rules, root)) fail('STATE_RULE_MISSING', scope, root, root);
}

function checkCoverage(value: Json, path: string, rules: Record<string, string>, scope: StateScope): void {
  const requireRule = (rulePath: string): void => {
    if (!Object.hasOwn(rules, rulePath) || typeof rules[rulePath] !== 'string' || !rules[rulePath]!.trim())
      fail('STATE_RULE_MISSING', scope, rulePath, rulePath);
  };
  requireRule(path);
  if (Array.isArray(value)) {
    const elementPath = path + '[]';
    requireRule(elementPath);
    for (const item of value) checkCoverage(item, elementPath, rules, scope);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) checkCoverage(item, path + '.' + key, rules, scope);
  }
}

/** Validate the complete root after every replacement, never just the submitted leaf. */
export function validateStateValue(definition: StateDefinition, value: unknown, root: string, scope: StateScope = 'message'): asserts value is Json {
  if (!isSafeStateKey(root)) fail('INVALID_STATE_KEY', scope, root);
  checkJson(value, 0, scope, root);
  if (!['string', 'number', 'boolean', 'json'].includes(definition.type)) fail('INVALID_STATE_TYPE', scope, root);
  if (definition.type !== 'json' && typeof value !== definition.type) fail('INVALID_STATE_VALUE', scope, root);
  if (definition.type === 'number' && typeof value === 'number') {
    if ((definition.min !== undefined && value < definition.min) || (definition.max !== undefined && value > definition.max))
      fail('STATE_OUT_OF_RANGE', scope, root);
  }
  checkSize(value, scope, root);
  if (!isRecord(definition.rules)) fail('INVALID_STATE', scope, root + '.rules');
  checkCoverage(value, root, definition.rules, scope);
}

function checkLoad(value: unknown, root: string, scope: StateScope): void {
  const path = root + '.load';
  if (!isRecord(value)) fail('INVALID_STATE', scope, path);
  strictKeys(value, ['mode', 'keywords', 'keyword_logic', 'exclude_keywords', 'when'], scope, path);
  if (value.mode !== undefined && !['always', 'on_mention', 'never'].includes(value.mode as string)) fail('INVALID_STATE', scope, path + '.mode');
  if (value.keyword_logic !== undefined && !['any', 'all'].includes(value.keyword_logic as string)) fail('INVALID_STATE', scope, path + '.keyword_logic');
  for (const key of ['keywords', 'exclude_keywords'] as const) {
    const keywords = value[key];
    if (keywords !== undefined && (!Array.isArray(keywords) || keywords.some(keyword => typeof keyword !== 'string' || !keyword.trim())))
      fail('INVALID_STATE', scope, path + '.' + key);
  }
  if (value.mode === 'on_mention' && !(value.keywords as string[] | undefined)?.length) fail('INVALID_STATE', scope, path + '.keywords');
  // The server additionally validates this expression with its existing when parser.
  if (value.when !== undefined && typeof value.when !== 'string') fail('INVALID_STATE', scope, path + '.when');
}

export function validateStateDefinition(root: string, definition: unknown, scope: StateScope = 'message'): asserts definition is StateDefinition {
  if (!isSafeStateKey(root)) fail('INVALID_STATE_KEY', scope, root);
  if (!isRecord(definition)) fail('INVALID_STATE', scope, root);
  strictKeys(definition, ['type', 'initial', 'description', 'rules', 'min', 'max', 'load'], scope, root);
  if (!['string', 'number', 'boolean', 'json'].includes(definition.type as string)) fail('INVALID_STATE_TYPE', scope, root + '.type');
  if (!Object.hasOwn(definition, 'initial')) fail('STATE_INITIAL_REQUIRED', scope, root);
  if (typeof definition.description !== 'string' || !definition.description.trim()) fail('INVALID_STATE', scope, root + '.description');
  checkRules(root, definition.rules, scope);
  for (const key of ['min', 'max'] as const) {
    const bound = definition[key];
    if (bound !== undefined && (definition.type !== 'number' || typeof bound !== 'number' || !Number.isFinite(bound)))
      fail('INVALID_STATE_RANGE', scope, root + '.' + key);
  }
  if (typeof definition.min === 'number' && typeof definition.max === 'number' && definition.min > definition.max)
    fail('INVALID_STATE_RANGE', scope, root);
  if (definition.load !== undefined) checkLoad(definition.load, root, scope);
  validateStateValue(definition as StateDefinition, definition.initial, root, scope);
  checkSize(definition, scope, root);
}

export function validateStateSchema(value: unknown): asserts value is StateSchema {
  if (!isRecord(value)) fail('INVALID_STATE', 'message', 'state');
  strictKeys(value, ['schema_version', 'scopes'], 'message', '');
  if (value.schema_version !== 2) fail('INVALID_STATE', 'message', 'schema_version');
  if (!isRecord(value.scopes)) fail('INVALID_STATE', 'message', 'scopes');
  strictKeys(value.scopes, scopes, 'message', 'scopes');
  for (const scope of scopes) {
    if (!Object.hasOwn(value.scopes, scope)) continue;
    const definitions = value.scopes[scope];
    if (!isRecord(definitions)) fail('INVALID_STATE', scope, '');
    for (const [root, definition] of Object.entries(definitions)) validateStateDefinition(root, definition, scope);
  }
  checkSize(value, 'message', 'state');
}

export function validateStateSnapshot(definitions: Record<string, StateDefinition>, value: unknown, scope: StateScope = 'message'): asserts value is Record<string, Json> {
  if (!isRecord(value)) fail('INVALID_STATE_VALUE', scope, '');
  const expected = Object.keys(definitions);
  const missing = expected.find(key => !Object.hasOwn(value, key));
  const extra = Object.keys(value).find(key => !Object.hasOwn(definitions, key));
  if (missing !== undefined || extra !== undefined) fail('STATE_SCHEMA_MISMATCH', scope, missing ?? extra!);
  for (const root of expected) validateStateValue(definitions[root]!, value[root], root, scope);
}
