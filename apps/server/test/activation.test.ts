import { describe, expect, it } from 'vitest';
import { evaluateLoad } from '../src/agent/activation.js';
import { setState } from '../src/agent/state-tool.js';

describe('content activation and direct state tool', () => {
  it('combines keyword, exclusions and when', () => {
    const state = { global: {}, session: {}, message: { hero: { hp: 5 } } };
    expect(evaluateLoad({ mode:'on_mention', keywords:['hero'], when:'getState("hero.hp") < 10' }, ['hero arrives'], state).active).toBe(true);
    expect(evaluateLoad({ mode:'on_mention', keywords:['hero'], exclude_keywords:['gone'] }, ['hero gone'], state).reason).toBe('excluded');
    expect(evaluateLoad({ mode:'always', when:'false' }, [], state).reason).toBe('when_false');
  });
  it('validates a state update before changing the workspace', () => {
    const modules = { hero: { type:'object', properties:{ hp:{ type:'integer', min:0, max:10 } } } };
    const state = { hero: { hp: 5 } };
    expect(() => setState(state, modules, new Set(['hero']), 'hero.hp', 100)).toThrow();
    expect(state.hero.hp).toBe(5);
    setState(state, modules, new Set(['hero']), 'hero.hp', 7);
    expect(state.hero.hp).toBe(7);
    expect(() => setState(state, modules, new Set(), 'hero.hp', 2)).toThrow();
  });
});
