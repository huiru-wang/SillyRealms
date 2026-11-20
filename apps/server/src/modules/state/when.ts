import { parseExpressionAt, type AnyNode } from 'acorn';
import lodash from 'lodash';
import type { JsonObject } from '../../infrastructure/database/connection.js';

export type StateViews = Record<'global' | 'session' | 'message', JsonObject>;
const blocked = new Set(['__proto__', 'constructor', 'prototype']);
const operators = new Set(['===', '!==', '<', '<=', '>', '>=', '+', '-', '*', '/', '%']);
const logical = new Set(['&&', '||', '??']);
const scopes = ['global', 'session', 'message'] as const;

function unsupported(): never { throw new Error('Unsupported when expression'); }

function statePath(node: AnyNode): string[] {
  let parts: string[];
  if (node.type === 'Literal' && typeof node.value === 'string') parts = lodash.toPath(node.value);
  else if (node.type === 'ArrayExpression') {
    parts = node.elements.map(element => {
      if (element?.type !== 'Literal' || typeof element.value !== 'string') unsupported();
      return element.value;
    });
  } else unsupported();
  if (!parts.length || parts.length > 32 || parts.some(part => !part || blocked.has(part))) unsupported();
  return parts;
}

function parse(input: string): AnyNode {
  if (Buffer.byteLength(input) > 4096) unsupported();
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
        if (node.optional || node.callee.type !== 'Identifier' || node.callee.name !== 'getState' ||
          node.arguments.length < 1 || node.arguments.length > 2) unsupported();
        statePath(node.arguments[0]!);
        const options = node.arguments[1];
        if (options) {
          if (options.type !== 'ObjectExpression' || options.properties.length !== 1) unsupported();
          const property = options.properties[0]!;
          if (property.type !== 'Property' || property.computed || property.key.type !== 'Identifier' ||
            property.key.name !== 'scope' || property.value.type !== 'Literal' ||
            !scopes.includes(property.value.value as typeof scopes[number])) unsupported();
        }
        break;
      }
      default: unsupported();
    }
  };
  validate(root);
  return root;
}

/** Interpret only the bounded author grammar; no JS evaluation or object method calls. */
export function evaluateWhen(input: string, state: StateViews): boolean {
  if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) unsupported();
  const evaluate = (node: AnyNode): unknown => {
    switch (node.type) {
      case 'Literal': return node.value;
      case 'UnaryExpression': {
        const value = evaluate(node.argument);
        if (value === undefined) unsupported();
        if (node.operator === '!') return !value;
        if (typeof value !== 'number' || !Number.isFinite(value)) unsupported();
        return node.operator === '-' ? -value : value;
      }
      case 'ConditionalExpression': {
        const condition = evaluate(node.test);
        if (condition === undefined) unsupported();
        return condition ? evaluate(node.consequent) : evaluate(node.alternate);
      }
      case 'LogicalExpression': {
        const left = evaluate(node.left);
        if (left === undefined && node.operator !== '??') unsupported();
        if (node.operator === '&&') return left && evaluate(node.right);
        if (node.operator === '||') return left || evaluate(node.right);
        return left ?? evaluate(node.right);
      }
      case 'CallExpression': {
        const path = statePath(node.arguments[0]!);
        const options = node.arguments[1];
        const property = options?.type === 'ObjectExpression' ? options.properties[0] : undefined;
        const scope = property?.type === 'Property' && property.value.type === 'Literal'
          ? property.value.value as typeof scopes[number] : undefined;
        for (const name of scope ? [scope] : scopes) {
          let current: unknown = state[name], found = true;
          for (const part of path) {
            if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
              found = false; break;
            }
            current = (current as Record<string, unknown>)[part];
          }
          if (found) return current;
        }
        return undefined;
      }
      case 'BinaryExpression': {
        const left = evaluate(node.left), right = evaluate(node.right);
        if (left === undefined || right === undefined) unsupported();
        if (node.operator === '===') return left === right;
        if (node.operator === '!==') return left !== right;
        if (['<', '<=', '>', '>='].includes(node.operator)) {
          // Match primitive JS comparisons without invoking author-owned object methods.
          const primitive = (value: unknown): string | number => {
            if (value === null) return 0;
            if (typeof value === 'boolean') return Number(value);
            if (typeof value === 'string' || typeof value === 'number') return value;
            return unsupported();
          };
          const a = primitive(left), b = primitive(right);
          if (node.operator === '<') return a < b;
          if (node.operator === '<=') return a <= b;
          if (node.operator === '>') return a > b;
          return a >= b;
        }
        if (typeof left !== 'number' || typeof right !== 'number') unsupported();
        const value = node.operator === '+' ? left + right : node.operator === '-' ? left - right
          : node.operator === '*' ? left * right : node.operator === '/' ? left / right : left % right;
        if (!Number.isFinite(value)) unsupported();
        return value;
      }
      default: return unsupported();
    }
  };
  const result = evaluate(parse(input));
  if (typeof result !== 'boolean') unsupported();
  return result;
}
