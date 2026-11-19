import { describe, expect, it } from 'vitest';
import { runtimeConfig } from './runtime-config.js';

describe('public runtime configuration', () => {
  it('returns an explicit isolated origin without duplicated port or private settings', () => {
    expect(runtimeConfig({ studioOrigin: 'http://127.0.0.1:5176' })).toEqual({
      stage: { origin: 'http://127.0.0.1:5177', entryPath: '/frame.html' }, debug: false,
    });
    expect(runtimeConfig({ studioOrigin: 'https://studio.test', stageOrigin: 'https://stage.test', debug: true }).debug).toBe(true);
  });
  it('rejects same-origin documents, HTTPS downgrade and malformed public origins', () => {
    for (const stageOrigin of ['https://studio.test', 'http://stage.test', 'https://stage.test/',
      'https://stage.test/frame.html', 'https://secret@stage.test', 'https://stage.test?x=1', 'javascript:void(0)']) {
      expect(() => runtimeConfig({ studioOrigin: 'https://studio.test', stageOrigin })).toThrow();
    }
  });
});
