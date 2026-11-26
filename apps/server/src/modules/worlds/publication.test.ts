import { describe, expect, it } from 'vitest';
import { parseCard } from './parser.js';
import { validateWorldPublication } from './service.js';
import { worldCardFixture } from './test-fixtures.js';

const publication = () => ({
  package_id: '8da0e392-2ea6-4ac1-a93a-b94abf6828a1',
  authors: [{ name: '雾灯', url: 'https://creator.example.org/' }],
  release: { version: '1.10.0', published_at: '2026-11-10T12:00:00+08:00', notes: '港口夜巡' },
  update_url: 'https://cdn.example.org/fog/releases.json',
});

describe('world publication protocol', () => {
  it('requires publication and accepts only the current world card format', () => {
    const current = worldCardFixture();
    expect(() => parseCard({ ...current, data: { ...current.data, publication: undefined } })).toThrow('publication');
    expect(() => parseCard({ ...current, spec_version: '0.1' })).toThrow('spec_version');
    const data = { ...current.data, publication: publication(), extensions: { authoring: { revision: '第二章' } } };
    const parsed = parseCard({ spec_version: '0.2', data });
    expect(parsed.data.publication).toEqual(publication());
    expect(parsed.data.extensions).toEqual(data.extensions);
    const offline = parseCard({ ...current, data: { ...current.data, extensions: data.extensions } });
    expect(offline.data.publication.update_url).toBeUndefined();
    expect(offline.data.extensions).toEqual(data.extensions);
  });

  it.each(['1.2', 'v1.2.0', '01.2.0', '1.2.0-beta', '1.2.0+build', '9007199254740992.0.0'])('rejects unstable or unsafe release version %s', version => {
    const value = publication();
    value.release.version = version;
    expect(() => validateWorldPublication(value)).toThrow('release.version');
  });

  it('rejects invalid identities, unsafe links, unknown keys and dates without timezone', () => {
    const value = publication();
    for (const invalid of [
      { ...value, package_id: value.package_id.toUpperCase() },
      { ...value, authors: [] },
      { ...value, authors: [{ name: '   ' }] },
      { ...value, authors: [{ name: 'A', url: 'javascript:alert(1)' }] },
      { ...value, homepage: 'data:text/html,x' },
      { ...value, update_url: 'http://cdn.example.org/releases.json' },
      { ...value, update_url: 'https://user:pass@cdn.example.org/releases.json' },
      { ...value, update_url: 'https://cdn.example.org/releases.json#fragment' },
      { ...value, release: { ...value.release, published_at: '2026-11-10T12:00:00' } },
      { ...value, unexpected: true },
      { ...value, authors: [{ name: 'A', verified: true }] },
      { ...value, release: { ...value.release, source: 'unknown' } },
    ]) expect(() => validateWorldPublication(invalid)).toThrow('INVALID_WORLD_CARD');
    expect(validateWorldPublication({ ...value, creator_notes: '', homepage: 'http://creator.example.org/' }))
      .toMatchObject({ creator_notes: '', homepage: 'http://creator.example.org/' });
  });
});
