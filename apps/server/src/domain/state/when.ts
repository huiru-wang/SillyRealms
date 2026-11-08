import { ErrorCodes } from '../../common/error-codes.js';
import { parseExpressionAt } from 'acorn';
import lodash from 'lodash';
import type { Node } from 'acorn';

type Expr = Node & Record<string, any>;
type State = Record<'global' | 'session' | 'message', Record<string, unknown>>;
const blocked = new Set(['__proto__', 'constructor', 'prototype']);
const operators = new Set(['===', '!==', '<', '<=', '>', '>=', '+', '-', '*', '/', '%']);
const logical = new Set(['&&', '||', '??']);
function error(): never { throw new Error(ErrorCodes.WHEN_UNSUPPORTED); }

function parse(input: string): Expr {
  if (Buffer.byteLength(input) > 4096) error();
  const node = parseExpressionAt(input, 0, { ecmaVersion: 'latest' }) as Expr;
  if (input.slice(node.end).trim()) error();
  let count = 0;
  function validate(n: Expr): void {
    if (++count > 256) error();
    switch (n.type) {
      case 'Literal': if (!(n.value === null || ['string', 'number', 'boolean'].includes(typeof n.value))) error(); break;
      case 'UnaryExpression': if (!['!', '+', '-'].includes(n.operator)) error(); validate(n.argument); break;
      case 'BinaryExpression': if (!operators.has(n.operator)) error(); validate(n.left); validate(n.right); break;
      case 'LogicalExpression': if (!logical.has(n.operator)) error(); validate(n.left); validate(n.right); break;
      case 'ConditionalExpression': validate(n.test); validate(n.consequent); validate(n.alternate); break;
      case 'CallExpression': {
        if (n.optional || n.callee.type !== 'Identifier' || n.callee.name !== 'getState' || n.arguments.length < 1 || n.arguments.length > 2) error();
        const path = n.arguments[0];
        if (path.type === 'Literal') { if (typeof path.value !== 'string') error(); }
        else if (path.type === 'ArrayExpression') { if (!path.elements.length || !path.elements.every((item: Expr) => item?.type === 'Literal' && typeof item.value === 'string')) error(); }
        else error();
        const parts:string[] = path.type==='ArrayExpression' ? path.elements.map((e:Expr)=>e.value) : lodash.toPath(path.value);
        if(!parts.length || parts.length>32 || parts.some(part=>!part || blocked.has(part))) error();
        const options = n.arguments[1];
        if (options && (options.type !== 'ObjectExpression' || options.properties.length !== 1 || options.properties[0].type !== 'Property' || options.properties[0].computed || options.properties[0].key.name !== 'scope' || options.properties[0].value.type !== 'Literal' || !['global','session','message'].includes(options.properties[0].value.value))) error();
        break;
      }
      default: error();
    }
  }
  validate(node); return node;
}
export function validateWhen(input: string): void { parse(input); }
export function evaluateWhen(input: string, state: State): boolean {
  if (Buffer.byteLength(JSON.stringify(state)) > 1024 * 1024) error();
  const root = parse(input);
  function evaluate(n: Expr): any {
    switch (n.type) {
      case 'Literal': return n.value;
      case 'UnaryExpression': { const v = evaluate(n.argument); if (v === undefined) error(); if (n.operator === '!') return !v; if (typeof v !== 'number' || !Number.isFinite(v)) error(); return n.operator === '-' ? -v : v; }
      case 'ConditionalExpression': { const test=evaluate(n.test); if (test === undefined) error(); return test ? evaluate(n.consequent) : evaluate(n.alternate); }
      case 'LogicalExpression': {
        const left = evaluate(n.left);
        if (left === undefined && n.operator !== '??') error();
        if (n.operator === '&&') return left && evaluate(n.right);
        if (n.operator === '||') return left || evaluate(n.right);
        return left ?? evaluate(n.right);
      }
      case 'CallExpression': {
        const path = n.arguments[0];
        const parts: string[] = path.type === 'ArrayExpression' ? path.elements.map((e: Expr) => e.value) : lodash.toPath(path.value);
        if (!parts.length || parts.length > 32 || parts.some(part => !part || blocked.has(part))) error();
        const scope = n.arguments[1]?.properties[0].value.value as keyof State | undefined;
        for (const name of scope ? [scope] : ['global','session','message'] as const) {
          let current: unknown = state[name]; let found = true;
          for (const part of parts) {
            if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) { found = false; break; }
            current = (current as Record<string, unknown>)[part];
          }
          if (found) return current;
        }
        return undefined;
      }
      case 'BinaryExpression': {
        const a = evaluate(n.left); const b = evaluate(n.right);
        if (a === undefined || b === undefined) error();
        switch (n.operator) {
          case '===': return a === b; case '!==': return a !== b;
          case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
          default: {
            if (typeof a !== 'number' || typeof b !== 'number') error();
            const value = n.operator === '+' ? a + b : n.operator === '-' ? a - b : n.operator === '*' ? a * b : n.operator === '/' ? a / b : a % b;
            if (!Number.isFinite(value)) error(); return value;
          }
        }
      }
      default: return error();
    }
  }
  const result: unknown = evaluate(root);
  if (typeof result !== 'boolean') error();
  return result;
}
