import { describe, expect, it } from 'vitest';
import { readMultipart } from './multipart.js';

function upload(bytes: Uint8Array = new TextEncoder().encode('{"name":"雾港"}'), filename = '世界.json') {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(bytes)], filename));
  const native = new Request('http://localhost/import', { method: 'POST', body: form });
  // Like the adapter, this object inherits Request.prototype without native internal slots.
  return Object.create(Request.prototype, {
    body: { value: native.body }, headers: { value: native.headers },
  }) as Request;
}

describe('bounded multipart parsing', () => {
  it.each(['世界.json', '世界.zip'])('reads %s bytes from the adapter-shaped request', async filename => {
    const bytes = new Uint8Array([0, 255, 80, 75, 10]);
    const form = await readMultipart(upload(bytes, filename), 4096);
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe(filename);
    expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(bytes);
  });

  it('also accepts a native request and preserves UTF-8 file content', async () => {
    const form = new FormData();
    form.set('file', new File(['雾港'], 'world.json'));
    const parsed = await readMultipart(new Request('http://localhost/import', { method: 'POST', body: form }), 4096);
    expect(await (parsed.get('file') as File).text()).toBe('雾港');
  });

  it('rejects oversized declared and actual bodies', async () => {
    const declared = upload();
    declared.headers.set('content-length', '5000');
    await expect(readMultipart(declared, 4096)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(readMultipart(upload(), 10)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
  });

  it('reports malformed multipart separately from payload limits', async () => {
    const body = new Response('not multipart').body;
    await expect(readMultipart({ body, headers: new Headers({ 'content-type': 'multipart/form-data; boundary=missing' }) }, 4096))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(readMultipart({ body: null, headers: new Headers() }, 4096))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
