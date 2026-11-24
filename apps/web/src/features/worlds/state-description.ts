import {i18n} from '../../i18n/instance.ts';
import {validateStateSchema, type Json, type StateDefinition, type StateSchema, type StateScope} from '@sillyrealms/sdk/state-validation';

export type StateDescriptionNode = {
  key: string;
  path: string;
  type: StateDefinition['type'] | 'object' | 'array' | 'null' | 'unknown' | 'mixed';
  description: string;
  container: boolean;
  children: StateDescriptionNode[];
};
export type StateDescriptionGroup = {scope: StateScope; nodes: StateDescriptionNode[]};

function valueType(value: Json) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'boolean';
  return typeof value === 'number' ? 'number' : 'string';
}

/** Called after schema validation. Rules describe templates, never individual array values. */
function describeRoot(name: string, definition: StateDefinition): StateDescriptionNode {
  const root: StateDescriptionNode = {
    key: name, path: name, type: definition.type, description: definition.type === 'json' && definition.rules && Object.hasOwn(definition.rules, name)
      ? definition.rules[name] : definition.description,
    container: definition.type === 'json', children: [],
  };
  if (definition.type !== 'json') return root;
  const nodes = new Map<string, StateDescriptionNode>([[name, root]]);
  const child = (parent: StateDescriptionNode, key: string) => {
    const path = parent.path + (key === '[]' ? key : '.' + key);
    let node = nodes.get(path);
    if (!node) {
      node = {key, path, type: 'unknown', description: definition.rules?.[path] ?? '', container: false, children: []};
      nodes.set(path, node);
      parent.children.push(node);
    }
    parent.container = true;
    return node;
  };
  // Include declared future fields even when their parents are null or their arrays are empty.
  for (const path of Object.keys(definition.rules ?? {})) {
    let parent = root;
    for (const key of (path.match(/[^.[\]]+|\[\]/g) ?? []).slice(1)) parent = child(parent, key);
  }
  const visit = (node: StateDescriptionNode, value: Json): void => {
    if (node !== root) {
      const type = valueType(value);
      node.type = node.type === 'unknown' || node.type === type ? type : 'mixed';
    }
    if (value === null || typeof value !== 'object') return;
    node.container = true;
    if (Array.isArray(value)) {
      const element = child(node, '[]');
      for (const item of value) visit(element, item);
    } else {
      for (const [key, item] of Object.entries(value)) visit(child(node, key), item);
    }
  };
  visit(root, definition.initial);
  return root;
}

export function describeWorldState(state: StateSchema | undefined): StateDescriptionGroup[] {
  if (state !== undefined) validateStateSchema(state);
  const groups: StateDescriptionGroup[] = [];
  for (const scope of ['global', 'session', 'message'] as const) {
    const definitions = Object.entries(state?.scopes[scope] ?? {});
    if (definitions.length) groups.push({scope, nodes: definitions.map(([name, definition]) => describeRoot(name, definition))});
  }
  return groups;
}

export function stateDescriptionLabel(node: StateDescriptionNode): string {
  return node.key === '[]' ? i18n.t('worlds:eachItem') : node.key;
}

export function shouldEnterStateDetail(mobile: boolean, depth: number): boolean {
  return mobile && depth >= 2;
}
