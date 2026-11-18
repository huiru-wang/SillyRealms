import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import { AppError, ERRORS, type ErrorCode } from '../errors.js';

export type SuccessResponse<T> = { success: true; errorCode: null; errorMessage: ''; data: T };
export type FailureResponse = { success: false; errorCode: ErrorCode; errorMessage: string; data: null };

export function success<T>(c: Context, data: T, status: 200 | 201 = 200): Response {
  const body: SuccessResponse<T> = { success: true, errorCode: null, errorMessage: '', data };
  return c.json(body, status);
}

export function failure(c: Context, code: ErrorCode, detail?: string): Response {
  const { message, status } = ERRORS[code];
  const body: FailureResponse = {
    success: false, errorCode: code,
    errorMessage: detail && status < 500 ? message + '：' + detail : message,
    data: null,
  };
  return c.json(body, status);
}

export function errorHandler(error: Error, c: Context): Response {
  if (error instanceof AppError) return failure(c, error.code, error.detail);
  if (error instanceof ZodError) {
    const detail = error.issues.slice(0, 8).map(issue =>
      (issue.path.length ? issue.path.map(String).join('.') + ': ' : '') + issue.message).join('；');
    return failure(c, 'INVALID_REQUEST', detail);
  }
  if (error instanceof HTTPException) {
    if (error.status === 400) return failure(c, 'INVALID_REQUEST');
    if (error.status === 404) return failure(c, 'NOT_FOUND');
    if (error.status === 405) return failure(c, 'METHOD_NOT_ALLOWED');
    if (error.status === 413) return failure(c, 'PAYLOAD_TOO_LARGE');
    if (error.status === 415) return failure(c, 'UNSUPPORTED_MEDIA_TYPE');
  }
  if ('code' in error && error.code === 'ERR_SQLITE_ERROR' && 'errcode' in error && typeof error.errcode === 'number') {
    if (error.errcode === 1555 || error.errcode === 2067) return failure(c, 'RESOURCE_CONFLICT');
    if (error.errcode === 787 || (error.errcode === 1811 && error.message === 'FOREIGN KEY constraint failed')) {
      return failure(c, 'REFERENCE_CONFLICT');
    }
    if (error.errcode === 275 || error.errcode === 1299) return failure(c, 'INVALID_REQUEST');
    if ((error.errcode & 255) === 5 || (error.errcode & 255) === 6) return failure(c, 'STORAGE_BUSY');
  }
  return failure(c, 'INTERNAL_ERROR');
}

/** The transport requires an object; the receiving Service validates its business fields. */
export async function readJson<T>(c: Context): Promise<T> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || !/^application\/(?:[a-z0-9.+-]+\+)?json$/.test(contentType)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE');
  }
  let body: unknown;
  try { body = await c.req.json<unknown>(); }
  catch { throw new AppError('INVALID_JSON'); }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('INVALID_REQUEST', '请求正文必须为 JSON 对象');
  }
  return body as T;
}

export function numberQuery(c: Context, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new AppError('INVALID_REQUEST', name + ' 必须为安全整数');
  }
  return Number(raw);
}
