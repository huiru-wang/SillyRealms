import type { StateReference } from '../../../lib/prompt-template.js';
import type { StateViews } from '../../../modules/state/service.js';
import type { JsonValue } from '../../../infrastructure/database/connection.js';

export type VisibleRoots = Record<keyof StateViews, ReadonlySet<string>>;

export function readStateVariable(reference: StateReference, views: StateViews, roots: VisibleRoots): string {
  if (!roots[reference.scope].has(reference.parts[0]!)) return '';
  let value: JsonValue = views[reference.scope];
  for (const key of reference.parts) {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return '';
    value = value[key]!;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}
