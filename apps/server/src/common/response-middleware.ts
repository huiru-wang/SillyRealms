import type { MiddlewareHandler } from 'hono';
import { ErrorCodes } from './error-codes.js';

/** Normalize JSON API responses; exported cards remain raw downloadable JSON. */
export const responseEnvelope: MiddlewareHandler = async (c,next) => {
  await next();
  if (!c.req.path.startsWith('/api/') && c.req.path !== '/health') return;
  const original=c.res;
  if (original.ok && (c.req.path.endsWith('/export') || c.req.path.endsWith('/source'))) return;
  if (!original.headers.get('content-type')?.toLowerCase().includes('application/json')) return;
  let body:unknown;
  try {body=await original.clone().json();} catch {return;}
  if (body && typeof body==='object' && 'code' in body && 'message' in body && 'data' in body) return;
  const input=body && typeof body==='object' ? body as Record<string,unknown> : {};
  const error=input.error && typeof input.error==='object' ? input.error as Record<string,unknown> : {};
  const output=original.ok ? {code:'OK',message:'',data:body} : {
    code:typeof error.code==='string'?error.code:ErrorCodes.INVALID_REQUEST,
    message:typeof error.message==='string'?error.message:'请求失败',
    data:null,
    ...(Object.keys(error).some(key => key !== 'code' && key !== 'message') ? {
      details:Object.fromEntries(Object.entries(error).filter(([key]) => key !== 'code' && key !== 'message')),
    } : {}),
  };
  const headers=new Headers(original.headers);
  headers.delete('content-length');
  c.res=new Response(JSON.stringify(output),{status:original.status,statusText:original.statusText,headers});
};
