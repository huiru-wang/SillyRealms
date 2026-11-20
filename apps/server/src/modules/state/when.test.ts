import { describe, expect, it } from 'vitest';
import { evaluateWhen, type StateViews } from './when.js';

const views: StateViews = {
  global: { coins: 4, flag: false }, session: { coins: 9 },
  message: { coins: 12, people: [{ name: 'Alice' }], nullable: null },
};

describe('bounded read-only when evaluation', () => {
  it('preserves scope priority, explicit scopes, nested paths and nullish defaults', () => {
    expect(evaluateWhen('getState("coins") === 4', views)).toBe(true);
    expect(evaluateWhen('getState("coins", {scope: "session"}) === 9', views)).toBe(true);
    expect(evaluateWhen('getState(["people", "0", "name"], {scope: "message"}) === "Alice"', views)).toBe(true);
    expect(evaluateWhen('(getState("missing") ?? 3) + 1 === 4 && !getState("flag")', views)).toBe(true);
    expect(evaluateWhen('getState("nullable") === null', views)).toBe(true);
    expect(evaluateWhen('getState("flag") ? false : 2 * 3 >= 6', views)).toBe(true);
  });

  it('uses lazy boolean branches and refuses missing values without an explicit fallback', () => {
    expect(evaluateWhen('false && getState("missing") === 0', views)).toBe(false);
    expect(evaluateWhen('true || getState("missing") === 0', views)).toBe(true);
    expect(() => evaluateWhen('getState("missing") === 0', views)).toThrow();
    expect(() => evaluateWhen('getState("coins")', views)).toThrow();
    expect(() => evaluateWhen('1 / 0 > 2', views)).toThrow();
  });

  it.each([
    'process.exit()', 'getState("coins").toString() === "4"', 'globalThis.value = 1',
    'getState("__proto__.secret") === 1', 'getState(["constructor"]) === 1',
    'getState("coins", {scope: "other"}) === 1', 'getState("coins") === 4; true',
    'getState("coins") == 4', '(() => true)()',
  ])('rejects executable or unsupported syntax: %s', expression => {
    expect(() => evaluateWhen(expression, views)).toThrow();
  });

  it('bounds source size, AST size and state snapshot size', () => {
    expect(() => evaluateWhen(' '.repeat(4096) + 'true', views)).toThrow();
    expect(() => evaluateWhen(Array.from({ length: 140 }, () => 'true').join(' && '), views)).toThrow();
    expect(() => evaluateWhen('true', { ...views, global: { text: 'x'.repeat(1024 * 1024) } })).toThrow();
  });
});
