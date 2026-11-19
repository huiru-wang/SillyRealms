import { AppError } from '../errors.js';
import type { EntryRunListOptions } from '../modules/sessions/service.js';
import { decodeCursor } from './pagination.js';

export function narrativeQuery(sessionId: string, query: Record<string, string | undefined>): EntryRunListOptions {
  if (query.limit !== undefined && query.limit !== '5') throw new AppError('INVALID_REQUEST', '每页固定 5 轮');
  if (query.cursor !== undefined && query.afterSeq !== undefined) {
    throw new AppError('INVALID_REQUEST', 'cursor 与 afterSeq 不能同时提供');
  }
  if (query.cursor !== undefined) {
    const position = decodeCursor(query.cursor, 'narrative:' + sessionId);
    if (Object.keys(position).length !== 1 || typeof position.beforeSeq !== 'number' ||
      !Number.isSafeInteger(position.beforeSeq) || position.beforeSeq <= 0) throw new AppError('INVALID_REQUEST');
    return { beforeSeq: position.beforeSeq };
  }
  if (query.afterSeq !== undefined) {
    const afterSeq = Number(query.afterSeq);
    if (!/^\d+$/.test(query.afterSeq) || !Number.isSafeInteger(afterSeq)) throw new AppError('INVALID_REQUEST');
    return { afterSeq };
  }
  return {};
}
