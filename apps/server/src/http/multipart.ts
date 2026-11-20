import { AppError } from '../errors.js';

/** The Node adapter supplies a Request-like object, not a native Fetch Request. */
export async function readMultipart(request: Pick<Request, 'headers' | 'body'>, maxBytes: number): Promise<FormData> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE');
  if (!request.body) throw new AppError('INVALID_REQUEST', '需要上传文件');
  let bytes = 0, tooLarge = false;
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        tooLarge = true;
        throw new AppError('PAYLOAD_TOO_LARGE');
      }
      controller.enqueue(chunk);
    },
  }));
  try {
    // Preserve the multipart boundary without cloning adapter-specific Request internals.
    return await new Response(body, { headers: request.headers }).formData();
  } catch {
    if (tooLarge) throw new AppError('PAYLOAD_TOO_LARGE');
    throw new AppError('INVALID_REQUEST', '无法读取上传文件');
  }
}
