import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worldImportLimits } from '../../modules/worlds/service.js';
import { isPublicAddress, worldUpdateDownloads } from './downloads.js';
import { releaseIndexLimits } from './protocol.js';
import type { WorldReleaseRecord } from './types.js';

const mocks = vi.hoisted(() => ({ request: vi.fn(), lookup: vi.fn() }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));

type Address = { address: string; family: number };
type RequestOptions = {
  method: string;
  agent: boolean;
  family: number;
  signal: AbortSignal;
  headers: Record<string, string>;
  lookup: (hostname: string, options: { all?: boolean }, callback: (
    error: Error | null, address: string | Address[], family?: number,
  ) => void) => void;
};
type ResponseStub = Readable & {
  statusCode: number;
  headers: Record<string, string>;
  complete: boolean;
};
type RequestCall = {
  url: URL;
  options: RequestOptions;
  response?: ResponseStub;
  dispose: () => void;
};

const calls: RequestCall[] = [];
const responses: (ResponseStub | Error | null)[] = [];
const publicAddress = { address: '8.8.8.8', family: 4 };
const source = 'https://releases.example.org/world/releases.json';
const signal = () => new AbortController().signal;

function response(
  body: string | Buffer | Buffer[] = '{}',
  options: { status?: number; headers?: Record<string, string>; complete?: boolean } = {},
): ResponseStub {
  const chunks = Array.isArray(body) ? body : [Buffer.isBuffer(body) ? body : Buffer.from(body)];
  return Object.assign(Readable.from(chunks), {
    statusCode: options.status ?? 200, headers: options.headers ?? {}, complete: options.complete ?? true,
  });
}
function artifact(bytes: Buffer, format: 'zip' | 'json' = 'zip'): WorldReleaseRecord {
  return {
    version: '1.0.0', published_at: '2026-11-26T00:00:00Z', notes: '', spec_version: '0.2',
    artifact: {
      format, url: 'https://files.example.net/versions/1.0.0/world.' + format,
      sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.byteLength,
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  responses.length = 0;
  mocks.request.mockReset();
  mocks.lookup.mockReset().mockResolvedValue([publicAddress]);
  mocks.request.mockImplementation((url: URL, options: RequestOptions, receive: (value: ResponseStub) => void) => {
    const request = new EventEmitter();
    const abort = () => {
      const error = new Error('Mock request aborted');
      call.response?.destroy(error);
      request.emit('error', error);
      call.dispose();
    };
    const call: RequestCall = {
      url, options,
      dispose: () => options.signal.removeEventListener('abort', abort),
    };
    calls.push(call);
    return Object.assign(request, {
      end: () => {
        options.signal.addEventListener('abort', abort, { once: true });
        queueMicrotask(() => {
          if (options.signal.aborted) { abort(); return; }
          const reply = responses.shift();
          if (reply === null) return; // Deliberately pending request, completed only by cancellation.
          if (reply === undefined || reply instanceof Error) {
            call.dispose();
            request.emit('error', reply ?? new Error('Unexpected unconfigured mock request'));
            return;
          }
          call.response = reply;
          reply.once('close', call.dispose);
          receive(reply);
        });
      },
    });
  });
});
afterEach(() => {
  for (const call of calls) { call.dispose(); call.response?.destroy(); }
  for (const item of responses) if (item instanceof Readable) item.destroy();
  vi.restoreAllMocks();
});

describe('public world release downloads', () => {
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts routable public address %s', address => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1',
    '255.255.255.255', '::1', 'fc00::1', 'fe80::1', '::ffff:8.8.8.8',
    '2001:db8::1', '2002::1', '3fff::1', 'not-an-address',
  ])('denies non-public or ambiguous address %s', address => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('rejects a mixed public/private DNS answer before opening any socket', async () => {
    mocks.lookup.mockResolvedValue([publicAddress, { address: '192.168.0.2', family: 4 }]);
    await expect(worldUpdateDownloads.getIndex(source, signal())).rejects.toMatchObject({ code: 'WORLD_DOWNLOAD_NOT_PUBLIC' });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.lookup).toHaveBeenCalledWith('releases.example.org', { all: true, verbatim: true });
  });

  it.each([
    'http://releases.example.org/index.json',
    'https://user:password@releases.example.org/index.json',
    'https://releases.example.org/index.json#fragment',
    'https://127.0.0.1/index.json',
    'https://[::1]/index.json',
  ])('rejects unsafe source %s without an HTTP request', async url => {
    await expect(worldUpdateDownloads.getIndex(url, signal())).rejects.toMatchObject({ code: 'WORLD_DOWNLOAD_NOT_PUBLIC' });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('pins the validated DNS answer while preserving HTTPS hostname and raw UTF-8 text', async () => {
    const text = '{\n  "说明": "完整原文",\n  "unknown": [1, 2]\n}\n';
    responses.push(response(text));
    await expect(worldUpdateDownloads.getIndex(source, signal())).resolves.toBe(text);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url.hostname).toBe('releases.example.org');
    expect(call.options).toMatchObject({
      method: 'GET', agent: false, family: 4,
      headers: { 'Accept-Encoding': 'identity' },
    });
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const answers: unknown[][] = [];
    call.options.lookup('releases.example.org', {}, (...args) => answers.push(args));
    call.options.lookup('releases.example.org', { all: true }, (...args) => answers.push(args));
    expect(answers).toEqual([[null, '8.8.8.8', 4], [null, [publicAddress], 4]]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it('follows public cross-origin and relative redirects, resolving each target separately', async () => {
    responses.push(
      response('', { status: 302, headers: { location: 'https://cdn.example.net/releases/index.json' } }),
      response('', { status: 307, headers: { location: '../final.json?revision=2' } }),
      response(' { "raw": true }\n'),
    );
    await expect(worldUpdateDownloads.getIndex(source, signal())).resolves.toBe(' { "raw": true }\n');
    expect(calls.map(call => call.url.href)).toEqual([
      source, 'https://cdn.example.net/releases/index.json', 'https://cdn.example.net/final.json?revision=2',
    ]);
    expect(mocks.lookup).toHaveBeenCalledTimes(3);
    expect(calls.slice(0, 2).every(call => call.response?.destroyed)).toBe(true);
  });

  it.each(['https://127.0.0.1/secret', 'https://[::1]/secret', 'http://public.example.org/file'])(
    'blocks a redirect to %s before requesting it', async location => {
      responses.push(response('', { status: 302, headers: { location } }));
      await expect(worldUpdateDownloads.getIndex(source, signal())).rejects.toMatchObject({ code: 'WORLD_DOWNLOAD_NOT_PUBLIC' });
      expect(calls).toHaveLength(1);
    },
  );

  it('revalidates DNS on redirects and rejects a new mixed answer', async () => {
    mocks.lookup.mockResolvedValueOnce([publicAddress]).mockResolvedValueOnce([
      publicAddress, { address: '169.254.169.254', family: 4 },
    ]);
    responses.push(response('', { status: 302, headers: { location: 'https://other.example.net/index.json' } }));
    await expect(worldUpdateDownloads.getIndex(source, signal())).rejects.toMatchObject({ code: 'WORLD_DOWNLOAD_NOT_PUBLIC' });
    expect(calls).toHaveLength(1);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });

  it('allows three redirects but refuses a fourth without opening a fifth request', async () => {
    for (let hop = 1; hop <= 4; hop++) {
      responses.push(response('', { status: 302, headers: { location: '/hop-' + hop } }));
    }
    await expect(worldUpdateDownloads.getIndex(source, signal())).rejects.toMatchObject({ code: 'WORLD_DOWNLOAD_FAILED' });
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)!.url.pathname).toBe('/hop-3');
  });

  it('accepts an exact third redirect followed by a final body', async () => {
    for (let hop = 1; hop <= 3; hop++) {
      responses.push(response('', { status: 302, headers: { location: '/hop-' + hop } }));
    }
    responses.push(response('{"final":true}'));
    await expect(worldUpdateDownloads.getIndex(source, signal())).resolves.toBe('{"final":true}');
    expect(calls).toHaveLength(4);
  });

  it.each([
    { status: 404 }, { status: 302 }, { headers: { 'content-encoding': 'gzip' } }, { complete: false },
  ])('does not turn failed, compressed, or truncated responses into a usable body: %j', async options => {
    responses.push(response('{}', options));
    await expect(worldUpdateDownloads.getIndex(source, signal())).rejects.toMatchObject({ code: 'WORLD_DOWNLOAD_FAILED' });
  });

  it('bounds both declared and streamed directory bytes rather than truncating them', async () => {
    responses.push(response('{}', { headers: { 'content-length': String(releaseIndexLimits.bytes + 1) } }));
    await expect(worldUpdateDownloads.getIndex(source, signal())).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    responses.push(response([Buffer.alloc(releaseIndexLimits.bytes), Buffer.from('x')]));
    await expect(worldUpdateDownloads.getIndex(source, signal())).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(calls.every(call => call.response?.destroyed)).toBe(true);
  });

  it('rejects invalid UTF-8 rather than silently replacing bytes in the original directory', async () => {
    responses.push(response(Buffer.from([0xc3, 0x28])));
    await expect(worldUpdateDownloads.getIndex(source, signal())).rejects.toMatchObject({ code: 'INVALID_WORLD_RELEASE_INDEX' });
  });

  it.each(['zip', 'json'] as const)('verifies exact original %s bytes, hash and size', async format => {
    const bytes = Buffer.from('original-世界-\u0000');
    const release = artifact(bytes, format);
    responses.push(response([bytes.subarray(0, 4), bytes.subarray(4)], {
      headers: { 'content-length': String(bytes.length), 'content-encoding': 'identity' },
    }));
    const downloaded = await worldUpdateDownloads.getArtifact(release, signal());
    expect(downloaded.format).toBe(format);
    expect(downloaded.bytes).toEqual(bytes);
    expect(calls[0]!.url.href).toBe(release.artifact.url);
  });

  it('rejects a same-length hash mismatch and a body shorter than the selected record', async () => {
    const bytes = Buffer.from('original');
    const release = artifact(bytes);
    responses.push(response(Buffer.from('tampered')));
    await expect(worldUpdateDownloads.getArtifact(release, signal())).rejects.toMatchObject({ code: 'WORLD_DOWNLOAD_HASH_MISMATCH' });
    responses.push(response(bytes.subarray(0, -1)));
    await expect(worldUpdateDownloads.getArtifact(release, signal())).rejects.toMatchObject({ code: 'WORLD_DOWNLOAD_HASH_MISMATCH' });
  });

  it('rejects artifact overflow and enforces the original format limit before network I/O', async () => {
    const bytes = Buffer.from('ok');
    const release = artifact(bytes);
    responses.push(response(Buffer.from('oversize')));
    await expect(worldUpdateDownloads.getArtifact(release, signal())).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    const before = mocks.lookup.mock.calls.length;
    release.artifact.size_bytes = worldImportLimits.zip + 1;
    await expect(worldUpdateDownloads.getArtifact(release, signal())).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(mocks.lookup).toHaveBeenCalledTimes(before);
    expect(calls).toHaveLength(1);
  });

  it('cancels before DNS and ignores a late DNS result after cancellation', async () => {
    const already = new AbortController();
    already.abort();
    await expect(worldUpdateDownloads.getIndex(source, already.signal)).rejects.toMatchObject({ code: 'WORLD_UPDATE_CANCELLED' });
    expect(mocks.lookup).not.toHaveBeenCalled();
    let resolveDns!: (value: Address[]) => void;
    mocks.lookup.mockReturnValue(new Promise<Address[]>(resolve => { resolveDns = resolve; }));
    const controller = new AbortController();
    const pending = worldUpdateDownloads.getIndex(source, controller.signal);
    const failed = expect(pending).rejects.toMatchObject({ code: 'WORLD_UPDATE_CANCELLED' });
    await vi.waitFor(() => expect(mocks.lookup).toHaveBeenCalledTimes(1));
    controller.abort();
    await failed;
    resolveDns([publicAddress]);
    await Promise.resolve();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('cancels an active response without accepting its partial body', async () => {
    const controller = new AbortController();
    const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: {}, complete: false });
    responses.push(stream);
    const pending = worldUpdateDownloads.getIndex(source, controller.signal);
    const failed = expect(pending).rejects.toMatchObject({ code: 'WORLD_UPDATE_CANCELLED' });
    await vi.waitFor(() => expect(calls[0]?.response).toBe(stream));
    stream.write('{"partial":');
    controller.abort();
    await failed;
    expect(stream.destroyed).toBe(true);
  });

  it('distinguishes a bounded timeout from user cancellation without waiting on real clocks', async () => {
    const timeout = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    responses.push(null);
    const pending = worldUpdateDownloads.getIndex(source, signal());
    const failed = expect(pending).rejects.toMatchObject({ code: 'WORLD_DOWNLOAD_TIMEOUT' });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(timer).toHaveBeenCalledWith(10_000);
    timeout.abort();
    await failed;
  });
});
