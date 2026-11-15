type Definition = {type?: string; initial?: unknown; min?: number; max?: number};
export type Row = {name: string; value: unknown; overridden: boolean};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const validKey = (key: string) => !!key && !key.includes('.') && !['__proto__', 'prototype', 'constructor'].includes(key);
function validJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => validJson(item, depth + 1));
  return object(value) && Object.entries(value).every(([key, item]) => validKey(key) && validJson(item, depth + 1));
}
function validValue(definition: Definition, value: unknown): boolean {
  if (definition.type === 'json') return validJson(value) && new TextEncoder().encode(JSON.stringify(value)).length <= 1024 * 1024;
  if (!['string', 'number', 'boolean'].includes(definition.type ?? '') || typeof value !== definition.type) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || (definition.min !== undefined && value < definition.min) || (definition.max !== undefined && value > definition.max))) return false;
  return new TextEncoder().encode(JSON.stringify(value)).length <= 1024 * 1024;
}
export function openingStateRows(state: unknown, override: unknown): Row[] {
  if (state != null && (!object(state) || state.schema_version !== 1 || !object(state.scopes))) throw new Error('状态定义格式无效');
  const scopes = object(state) && object(state.scopes) ? state.scopes : {};
  const definitions = scopes.message ?? {};
  if (!object(definitions) || (override != null && !object(override))) throw new Error('消息状态或开局覆盖格式无效');
  const overrides = object(override) ? override : {};
  for (const key of Object.keys(overrides)) if (!validKey(key) || !Object.hasOwn(definitions, key)) throw new Error(`开局覆盖了未定义的状态：${key}`);
  return Object.entries(definitions).map(([name, raw]) => {
    if (!validKey(name) || !object(raw) || !Object.hasOwn(raw, 'initial')) throw new Error(`状态定义无效：${name}`);
    const definition = raw as Definition;
    if (definition.type === 'number' ? (definition.min !== undefined && !Number.isFinite(definition.min)) || (definition.max !== undefined && !Number.isFinite(definition.max)) || (definition.min !== undefined && definition.max !== undefined && definition.min > definition.max) : definition.min !== undefined || definition.max !== undefined) throw new Error(`状态范围无效：${name}`);
    const overridden = Object.hasOwn(overrides, name);
    const value = overridden ? overrides[name] : definition.initial;
    if (!validValue(definition, definition.initial) || !validValue(definition, value)) throw new Error(`状态值无效：${name}`);
    return {name, value, overridden};
  });
}

