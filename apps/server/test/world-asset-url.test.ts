import {describe, expect, it} from 'vitest';
import {parseSRAssetUri, parseSRAssetBaseUrl, resolveSRAssetUrl, validatePackagePath} from '../../../packages/sr-sdk/src/asset-url.js';

const base = 'http://192.168.1.8:3001/world-assets/world-one/';

describe('world package resource addresses', () => {
  it('keeps the package root and supports nested Unicode paths without a browser location', () => {
    expect(parseSRAssetUri('sr-asset://assets/images/harbor.webp')).toBe('assets/images/harbor.webp');
    expect(parseSRAssetUri('sr-asset://components/stage/Main.tsx', 'components')).toBe('components/stage/Main.tsx');
    expect(validatePackagePath('world.json')).toBe('world.json');
    expect(resolveSRAssetUrl('sr-asset://assets/images/雾港 封面.webp', base))
      .toBe(base + 'assets/images/' + encodeURIComponent('雾港 封面.webp'));
    expect(resolveSRAssetUrl('sr-asset://assets/images/a&b.webp', base)).toBe(base + 'assets/images/a%26b.webp');
  });

  it('rejects path traversal, encodings, platform aliases and wrong package roots', () => {
    for (const path of ['', '/assets/x', '../x', 'assets/../x', 'assets/./x', 'assets//x', 'assets/x/',
      'C:/x', 'assets\\x', 'assets/a\u0000b', 'assets/a\nb', 'assets/%2e%2e/x',
      'assets/x?query', 'assets/x#fragment', 'assets/a:b', 'assets/con.txt', 'assets/aux',
      'assets/a.', 'assets/a ', 'assets/' + 'x'.repeat(256)]) {
      expect(() => validatePackagePath(path), path).toThrow();
    }
    expect(() => parseSRAssetUri('sr-asset://world.json')).toThrow();
    expect(() => parseSRAssetUri('sr-asset://components/Main.tsx', 'assets')).toThrow();
    expect(() => parseSRAssetUri('sr-asset://assets/image.webp', 'components')).toThrow();
    expect(() => parseSRAssetUri('sr-asset:/assets/image.webp')).toThrow();
    expect(() => parseSRAssetUri('sr-asset://assets')).toThrow();
  });

  it('only converts current-world assets and preserves ordinary HTTP(S) addresses', () => {
    expect(resolveSRAssetUrl(null, null)).toBeNull();
    expect(resolveSRAssetUrl(undefined, undefined)).toBeNull();
    expect(resolveSRAssetUrl('https://example.test/image.webp?q=1#view', null))
      .toBe('https://example.test/image.webp?q=1#view');
    expect(resolveSRAssetUrl('http://example.test/image.webp', null)).toBe('http://example.test/image.webp');
    expect(() => resolveSRAssetUrl('sr-asset://assets/a.webp', null)).toThrow('缺少当前世界');
    for (const uri of ['javascript:alert(1)', 'file:///tmp/a.webp', 'data:image/png;base64,a',
      '//example.test/a.webp', 'assets/a.webp', 'sr-asset://components/Main.tsx', 'https://user:pass@example.test/a']) {
      expect(() => resolveSRAssetUrl(uri, base), uri).toThrow();
    }
    expect(resolveSRAssetUrl('sr-asset://assets/a.webp', base.replace('world-one', 'world-two')))
      .toContain('/world-assets/world-two/assets/a.webp');
  });

  it('requires a trustworthy absolute per-world base and never reuses a host page origin', () => {
    expect(parseSRAssetBaseUrl(base).origin).toBe('http://192.168.1.8:3001');
    for (const value of ['/world-assets/world-one/', 'javascript:alert(1)', 'https://example.test/',
      'https://example.test/world-assets/world-one', base + '?token=x', base + '#x',
      'http://user:pass@example.test/world-assets/world-one/']) {
      expect(() => resolveSRAssetUrl('sr-asset://assets/a.webp', value), value).toThrow();
    }
  });
});
