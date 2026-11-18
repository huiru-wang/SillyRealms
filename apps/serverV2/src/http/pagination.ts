import type { Context } from 'hono';
import { AppError } from '../errors.js';
import { numberQuery } from './response.js';

export type Page<T> = { items: T[]; hasMore: boolean; nextCursor: string | null };
export type OffsetPagination = { limit: number; offset: number };

/** Cursor encoding belongs to HTTP; Services receive typed positions instead. */
export function encodeCursor(scope: string, position: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ version: 1, scope, position })).toString('base64url');
}

export function decodeCursor(raw: string, scope: string): Record<string, unknown> {
  try {
    if (!raw || raw.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('cursor');
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) throw new Error('cursor');
    const decoded: unknown = JSON.parse(bytes.toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('cursor');
    const value = decoded as Record<string, unknown>;
    if (Object.keys(value).length !== 3 || value.version !== 1 || value.scope !== scope ||
      !value.position || typeof value.position !== 'object' || Array.isArray(value.position)) {
      throw new Error('cursor');
    }
    return value.position as Record<string, unknown>;
  } catch {
    throw new AppError('INVALID_REQUEST', '分页游标无效或不属于当前查询');
  }
}

export function readOffsetPagination(
  c: Context,
  scope: string,
  { defaultLimit = 50, maxLimit = 200 }: { defaultLimit?: number; maxLimit?: number } = {},
): OffsetPagination {
  const limit = numberQuery(c, 'limit') ?? defaultLimit;
  if (limit < 1 || limit > maxLimit) throw new AppError('INVALID_REQUEST', 'limit 超出允许范围');
  const rawCursor = c.req.query('cursor');
  let offset = numberQuery(c, 'offset') ?? 0;
  if (rawCursor !== undefined) {
    if (c.req.query('offset') !== undefined) throw new AppError('INVALID_REQUEST', 'cursor 与 offset 不能同时提供');
    const cursor = decodeCursor(rawCursor, scope);
    if (Object.keys(cursor).length !== 1 || typeof cursor.offset !== 'number' ||
      !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
      throw new AppError('INVALID_REQUEST', '分页游标位置无效');
    }
    offset = cursor.offset;
  }
  if (offset < 0 || !Number.isSafeInteger(offset + limit)) {
    throw new AppError('INVALID_REQUEST', 'offset 超出允许范围');
  }
  return { limit, offset };
}

export function offsetPage<T>(
  items: T[], hasMore: boolean, { offset }: OffsetPagination, scope: string,
): Page<T> {
  return { items, hasMore, nextCursor: hasMore ? encodeCursor(scope, { offset: offset + items.length }) : null };
}
