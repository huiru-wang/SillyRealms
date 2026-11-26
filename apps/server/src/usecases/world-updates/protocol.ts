import { z } from 'zod';
import { compareReleaseVersion, isReleaseVersion } from '@sillyrealms/sdk/release-version';
import { AppError } from '../../errors.js';
import type { WorldReleaseRecord, WorldVersionIndex } from './types.js';

export const releaseIndexLimits = Object.freeze({ bytes: 2 * 1024 * 1024, versions: 1000 });
const httpsUrl = z.string().refine(value => {
  try {
    const url = new URL(value);
    return value === value.trim() && url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash;
  } catch { return false; }
});
const recordSchema = z.object({
  version: z.string().refine(isReleaseVersion),
  title: z.string().optional(),
  published_at: z.iso.datetime({ offset: true }),
  notes: z.string(),
  spec_version: z.string().min(1).max(32),
  artifact: z.object({
    format: z.enum(['zip', 'json']),
    url: httpsUrl,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).passthrough(),
}).passthrough();
const indexSchema = z.object({
  schema_version: z.literal(1),
  package_id: z.uuid().refine(value => value === value.toLowerCase()),
  versions: z.array(recordSchema).max(releaseIndexLimits.versions),
}).passthrough();

/** Pure protocol validation, shared with the creator release tool. */
export function validateReleaseIndex(
  value: unknown, expectedPackageId?: string, previous?: WorldVersionIndex | null,
): WorldVersionIndex {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > releaseIndexLimits.bytes) throw new Error('Index too large');
  } catch { throw new AppError('INVALID_WORLD_RELEASE_INDEX'); }
  const parsed = indexSchema.safeParse(value);
  if (!parsed.success) throw new AppError('INVALID_WORLD_RELEASE_INDEX');
  const index = parsed.data as WorldVersionIndex;
  if (expectedPackageId !== undefined && index.package_id !== expectedPackageId) {
    throw new AppError('WORLD_UPDATE_SOURCE_CHANGED');
  }
  const versions = new Set<string>();
  const oldHashes = new Map(previous?.package_id === index.package_id
    ? previous.versions.map(item => [item.version, item.artifact.sha256]) : []);
  for (const release of index.versions) {
    if (versions.has(release.version)) throw new AppError('INVALID_WORLD_RELEASE_INDEX', '版本号重复：' + release.version);
    versions.add(release.version);
    const oldHash = oldHashes.get(release.version);
    if (oldHash !== undefined && oldHash !== release.artifact.sha256) {
      throw new AppError('WORLD_UPDATE_CONFLICT', '同一发行版本的文件内容已改变：' + release.version);
    }
  }
  return { ...index, versions: [...index.versions].sort((a, b) => compareReleaseVersion(b.version, a.version)) };
}

export function parseReleaseIndex(text: string, packageId: string, previous?: WorldVersionIndex | null): WorldVersionIndex {
  if (Buffer.byteLength(text, 'utf8') > releaseIndexLimits.bytes) throw new AppError('INVALID_WORLD_RELEASE_INDEX');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new AppError('INVALID_WORLD_RELEASE_INDEX'); }
  return validateReleaseIndex(value, packageId, previous);
}

export function requireRelease(index: WorldVersionIndex | null, version: string): WorldReleaseRecord {
  if (!index) throw new AppError('WORLD_RELEASE_INDEX_REQUIRED');
  const release = index.versions.find(item => item.version === version);
  if (!release) throw new AppError('WORLD_RELEASE_NOT_FOUND');
  return release;
}
