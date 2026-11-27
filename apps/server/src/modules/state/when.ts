import type { AnyNode } from 'acorn';
import { parseWhen, whenStateReference } from '@sillyrealms/sdk/when-expression';
import type { JsonObject } from '../../infrastructure/database/connection.js';

export type StateViews = Record<'global' | 'session' | 'message', JsonObject>;
const scopes = ['global', 'session', 'message'] as const;

function unsupported(): never { throw new Error('Unsupported when expression'); }

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
        const { path, scope } = whenStateReference(node);
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
  const result = evaluate(parseWhen(input));
  if (typeof result !== 'boolean') unsupported();
  return result;
}
