import { describe, expect, it } from 'vitest';
import { compareReleaseVersion, parseReleaseVersion } from '@sillyrealms/sdk/release-version';
import { parseReleaseIndex, releaseIndexLimits, validateReleaseIndex } from './protocol.js';

const id = '49e876ea-152b-4d13-a75d-6d342211a127';
const record = (version = '1.0.0') => ({
  version, published_at: '2026-11-26T10:00:00+08:00', notes: '修复', spec_version: '0.2',
  artifact: { format: 'zip', url: 'https://cdn.example/card.zip', sha256: 'a'.repeat(64), size_bytes: 123 },
});
const index = () => ({ schema_version: 1, package_id: id, versions: [record()] });

describe('world release protocol', () => {
  it('compares stable numeric tuples consistently, without coercing unsupported versions', () => {
    expect(compareReleaseVersion('1.10.0', '1.9.99')).toBe(1);
    expect(compareReleaseVersion('2.0.0', '10.0.0')).toBe(-1);
    expect(compareReleaseVersion('1.2.3', '1.2.3')).toBe(0);
    for (const invalid of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-rc.1', '1.0.0+meta', '1.0.0 ', '9007199254740992.0.0', 1, null]) {
      expect(parseReleaseVersion(invalid)).toBeNull();
    }
  });

  it('sorts numerically and retains unknown fields while accepting a valid empty index', () => {
    const value = { ...index(), future: { keep: true }, versions: [record('1.9.0'), { ...record('1.10.0'), custom: 'keep', spec_version: '0.9' }] };
    expect(validateReleaseIndex(value, id)).toMatchObject({ future: { keep: true }, versions: [{ version: '1.10.0', custom: 'keep', spec_version: '0.9' }, { version: '1.9.0' }] });
    expect(validateReleaseIndex({ ...index(), versions: [] }).versions).toEqual([]);
    expect(value.versions[0]!.version).toBe('1.9.0');
  });

  it('rejects malformed fields, duplicate releases, incompatible schemas and noncanonical identities', () => {
    const invalid: unknown[] = [
      {}, { ...index(), schema_version: 2 }, { ...index(), package_id: id.toUpperCase() },
      { ...index(), versions: [record(), record()] },
      ...['1.0', '1.0.0-rc.1'].map(version => ({ ...index(), versions: [record(version)] })),
      { ...index(), versions: [{ ...record(), published_at: '2026-11-26' }] },
      ...['http://example.com/a', 'https://name:secret@example.com/a', 'https://example.com/a#fragment'].map(url =>
        ({ ...index(), versions: [{ ...record(), artifact: { ...record().artifact, url } }] })),
      { ...index(), versions: [{ ...record(), artifact: { ...record().artifact, sha256: 'A'.repeat(64) } }] },
      { ...index(), versions: [{ ...record(), artifact: { ...record().artifact, size_bytes: 0 } }] },
      { ...index(), versions: Array.from({ length: releaseIndexLimits.versions + 1 }, (_, i) => record('1.0.' + i)) },
    ];
    for (const value of invalid) expect(() => validateReleaseIndex(value)).toThrow('INVALID_WORLD_RELEASE_INDEX');
    expect(() => parseReleaseIndex('{broken', id)).toThrow('INVALID_WORLD_RELEASE_INDEX');
    expect(() => validateReleaseIndex(index(), 'ae8e8a95-edb9-4c41-969f-c8161e3b3593')).toThrow('WORLD_UPDATE_SOURCE_CHANGED');
  });

  it('rejects same-version hash mutation and oversized JSON, but allows release withdrawal', () => {
    const previous = validateReleaseIndex(index());
    const changed = { ...index(), versions: [{ ...record(), artifact: { ...record().artifact, sha256: 'b'.repeat(64) } }] };
    expect(() => validateReleaseIndex(changed, id, previous)).toThrow('WORLD_UPDATE_CONFLICT');
    expect(validateReleaseIndex({ ...index(), versions: [] }, id, previous).versions).toEqual([]);
    expect(() => validateReleaseIndex({ ...index(), extra: 'x'.repeat(releaseIndexLimits.bytes) })).toThrow('INVALID_WORLD_RELEASE_INDEX');
    const compact = JSON.stringify(index());
    expect(() => parseReleaseIndex(' '.repeat(releaseIndexLimits.bytes) + compact, id)).toThrow('INVALID_WORLD_RELEASE_INDEX');
  });
});
