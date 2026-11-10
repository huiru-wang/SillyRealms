import type { MiddlewareHandler } from 'hono';
import { ErrorCodes } from './error-codes.js';
import { failure, ok } from './http-response.js';

/** Normalize all ordinary JSON responses; exported cards and SSE remain untouched. */
export const responseEnvelope: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.req.path.startsWith('/api/') && c.req.path !== '/health') return;
  const original = c.res;
  if (original.ok && (c.req.path.endsWith('/export') || c.req.path.endsWith('/source'))) return;
  if (!original.headers.get('content-type')?.toLowerCase().includes('application/json')) return;
  let body: unknown;
  try { body = await original.clone().json(); } catch { return; }

  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown> : null;
  const alreadyWrapped = input && typeof input.success === 'boolean' &&
    'errorCode' in input && 'errorMessage' in input && 'data' in input;
  const output = alreadyWrapped
    ? body
    : original.ok ? ok(body)
      : failure(original.status >= 500 ? ErrorCodes.INTERNAL_ERROR : ErrorCodes.INVALID_REQUEST);

  const headers = new Headers(original.headers);
  headers.delete('content-length');
  c.res = new Response(JSON.stringify(output), {
    status: original.status, statusText: original.statusText, headers,
  });
};
