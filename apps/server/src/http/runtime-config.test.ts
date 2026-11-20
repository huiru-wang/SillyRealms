import { describe, expect, it } from 'vitest';
import { runtimeConfig } from './runtime-config.js';

describe('public runtime configuration', () => {
  it('returns an explicit isolated origin without duplicated port or private settings', () => {
    expect(runtimeConfig({ webOrigin: 'http://127.0.0.1:5176' })).toEqual({
      stage: { origin: 'http://127.0.0.1:5177', entryPath: '/frame.html' }, debug: false,
    });
    expect(runtimeConfig({ webOrigin: 'http://192.168.1.21:5176', debug: true })).toEqual({
      stage: { origin: 'http://192.168.1.21:5177', entryPath: '/frame.html' }, debug: true,
    });
    expect(runtimeConfig({ webOrigin: 'https://web.test', stageOrigin: 'https://stage.test', debug: true }).debug).toBe(true);
  });
  it('rejects same-origin documents, HTTPS downgrade and malformed public origins', () => {
    for (const stageOrigin of ['https://web.test', 'http://stage.test', 'https://stage.test/',
      'https://stage.test/frame.html', 'https://secret@stage.test', 'https://stage.test?x=1', 'javascript:void(0)']) {
      expect(() => runtimeConfig({ webOrigin: 'https://web.test', stageOrigin })).toThrow();
    }
  });
});
