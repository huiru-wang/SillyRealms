import { parseExpressionAt, type AnyNode } from 'acorn';
import toPath from 'lodash/toPath.js';
import type { StateScope } from './state-validation.ts';

export type WhenStateReference = { path: string[]; scope: StateScope | null };

const blocked = new Set(['__proto__', 'constructor', 'prototype']);
const operators = new Set(['===', '!==', '<', '<=', '>', '>=', '+', '-', '*', '/', '%']);
const logical = new Set(['&&', '||', '??']);
function unsupported(): never { throw new Error('Unsupported when expression'); }

export function whenStateReference(node: Extract<AnyNode, { type: 'CallExpression' }>): WhenStateReference {
  if (node.optional || node.callee.type !== 'Identifier' || node.callee.name !== 'getState' ||
    node.arguments.length < 1 || node.arguments.length > 2) unsupported();
  const path = node.arguments[0]!;
  let parts: string[];
  if (path.type === 'Literal' && typeof path.value === 'string') parts = toPath(path.value);
  else if (path.type === 'ArrayExpression') {
    parts = path.elements.map(element => {
      if (element?.type !== 'Literal' || typeof element.value !== 'string') unsupported();
      return element.value;
    });
  } else unsupported();
  if (!parts.length || parts.length > 32 || parts.some(part => !part || blocked.has(part))) unsupported();
  const options = node.arguments[1];
  let scope: StateScope | null = null;
  if (options) {
    if (options.type !== 'ObjectExpression' || options.properties.length !== 1) unsupported();
    const property = options.properties[0]!;
    if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier' ||
      property.key.name !== 'scope' || property.value.type !== 'Literal' ||
      typeof property.value.value !== 'string' || !['global', 'session', 'message'].includes(property.value.value)) unsupported();
    scope = property.value.value as StateScope;
  }
  return { path: parts, scope };
}

/** Validate the bounded author expression grammar; this module never evaluates expressions. */
export function parseWhen(input: string, onReference?: (reference: WhenStateReference) => void): AnyNode {
  if (new TextEncoder().encode(input).length > 4096) unsupported();
  const root = parseExpressionAt(input, 0, { ecmaVersion: 'latest' });
  if (input.slice(root.end).trim()) unsupported();
  let count = 0;
  const validate = (node: AnyNode): void => {
    if (++count > 256) unsupported();
    switch (node.type) {
      case 'Literal':
        if (!(node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value))) unsupported();
        break;
      case 'UnaryExpression':
        if (!['!', '+', '-'].includes(node.operator)) unsupported();
        validate(node.argument); break;
      case 'BinaryExpression':
        if (!operators.has(node.operator)) unsupported();
        validate(node.left); validate(node.right); break;
      case 'LogicalExpression':
        if (!logical.has(node.operator)) unsupported();
        validate(node.left); validate(node.right); break;
      case 'ConditionalExpression':
        validate(node.test); validate(node.consequent); validate(node.alternate); break;
      case 'CallExpression': {
        const reference = whenStateReference(node);
        onReference?.(reference);
        break;
      }
      default: unsupported();
    }
  };
  validate(root);
  return root;
}
