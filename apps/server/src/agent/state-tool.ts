import lodash from 'lodash';
import { validateValue, type Json } from '../domain/state/state.js';
const forbidden = new Set(['__proto__','constructor','prototype']);
type Def = { type: string; properties?: Record<string, Def>; [key: string]: unknown };

export function setState(workspace: Record<string, Json>, modules: Record<string, Def>, active: Set<string>, path: string | string[], value: unknown): void {
  const parts = typeof path === 'string' ? lodash.toPath(path) : path;
  if (!parts.length || parts.length > 32 || parts.some(p => typeof p !== 'string' || !p || forbidden.has(p))) throw new Error('INVALID_STATE_PATH');
  const root = parts[0]!;
  if (!active.has(root) || !Object.hasOwn(modules, root) || !Object.hasOwn(workspace, root)) throw new Error('STATE_ROOT_NOT_ACTIVE');
  let definition: Def = modules[root]!;
  let current: Json = workspace[root]!;
  if (parts.length === 1) throw new Error('STATE_GROUP_NOT_WRITABLE');
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i]!;
    if (definition.type !== 'object' || !definition.properties || !Object.hasOwn(definition.properties, key) || current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, key)) throw new Error('INVALID_STATE_PATH');
    const child = definition.properties[key]!;
    if (i === parts.length - 1) {
      if (child.type === 'object') throw new Error('STATE_GROUP_NOT_WRITABLE');
      if (Buffer.byteLength(JSON.stringify(value) ?? '') > 1024 * 1024) throw new Error('STATE_VALUE_TOO_LARGE');
      validateValue(child, value, parts.join('.'));
      current[key] = structuredClone(value);
      return;
    }
    current = current[key]!; definition = child;
  }
}

export const stateTool = { name:'set_state',description:'Update a declared active message state leaf.',parameters:{type:'object',properties:{path:{anyOf:[{type:'string'},{type:'array',items:{type:'string'}}]},value:{}},required:['path','value'],additionalProperties:false} };
