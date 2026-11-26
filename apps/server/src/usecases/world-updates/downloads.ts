import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { AppError } from '../../errors.js';
import { worldImportLimits, type WorldImportInput } from '../../modules/worlds/service.js';
import { releaseIndexLimits } from './protocol.js';
import type { WorldReleaseRecord } from './types.js';

export type WorldUpdateDownloads = {
  getIndex(url: string, signal: AbortSignal): Promise<string>;
  getArtifact(release: WorldReleaseRecord, signal: AbortSignal): Promise<WorldImportInput>;
};

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) denied.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
}

function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('WORLD_DOWNLOAD_NOT_PUBLIC'); }
  if (value !== value.trim() || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new AppError('WORLD_DOWNLOAD_NOT_PUBLIC');
  }
  return url;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function resolvePublic(url: URL, signal: AbortSignal): Promise<LookupAddress> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new AppError('WORLD_DOWNLOAD_NOT_PUBLIC');
  return addresses[0]!;
}

type Hop = { bytes: Buffer } | { redirect: string };
function fetchHop(url: URL, address: LookupAddress, limit: number, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, family: address.family, signal,
      // Pin the validated DNS answer: the socket must not resolve the hostname a second time.
      lookup: (_hostname, options, callback) => callback(null, options.all ? [address] : address.address, address.family),
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
    }, response => {
      void (async () => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          if (!location) throw new AppError('WORLD_DOWNLOAD_FAILED');
          resolve({ redirect: location });
          return;
        }
        const encoding = response.headers['content-encoding'];
        if (status !== 200 || (encoding && encoding.toLowerCase() !== 'identity')) {
          response.destroy();
          throw new AppError('WORLD_DOWNLOAD_FAILED');
        }
        const declared = response.headers['content-length'];
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
          response.destroy();
          throw new AppError('PAYLOAD_TOO_LARGE');
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response) {
          signal.throwIfAborted();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          size += bytes.byteLength;
          if (size > limit) {
            response.destroy();
            throw new AppError('PAYLOAD_TOO_LARGE');
          }
          chunks.push(bytes);
        }
        if (!response.complete) throw new AppError('WORLD_DOWNLOAD_FAILED');
        resolve({ bytes: Buffer.concat(chunks, size) });
      })().catch(reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function download(urlText: string, limit: number, timeoutMs: number, external: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([external, timeout]);
  try {
    let url = publicUrl(urlText);
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      const address = await resolvePublic(url, signal);
      const result = await fetchHop(url, address, limit, signal);
      if ('bytes' in result) return result.bytes;
      if (redirects >= 3) throw new AppError('WORLD_DOWNLOAD_FAILED', 'Too many redirects');
      url = publicUrl(new URL(result.redirect, url).href);
    }
  } catch (error) {
    if (external.aborted) throw new AppError('WORLD_UPDATE_CANCELLED');
    if (timeout.aborted) throw new AppError('WORLD_DOWNLOAD_TIMEOUT');
    if (error instanceof AppError) throw error;
    throw new AppError('WORLD_DOWNLOAD_FAILED');
  }
}

export const worldUpdateDownloads: WorldUpdateDownloads = {
  async getIndex(url, signal) {
    const bytes = await download(url, releaseIndexLimits.bytes, 10_000, signal);
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new AppError('INVALID_WORLD_RELEASE_INDEX'); }
  },
  async getArtifact(release, signal) {
    const { artifact } = release;
    const limit = worldImportLimits[artifact.format];
    if (artifact.size_bytes > limit) throw new AppError('PAYLOAD_TOO_LARGE');
    const bytes = await download(artifact.url, Math.min(limit, artifact.size_bytes), 120_000, signal);
    if (bytes.byteLength !== artifact.size_bytes || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
      throw new AppError('WORLD_DOWNLOAD_HASH_MISMATCH');
    }
    return { format: artifact.format, bytes };
  },
};
