import { AppError } from '../errors.js';
import { decodeCursor } from './pagination.js';
import type { RunOptions } from '../modules/sessions/service.js';

export function narrativeQuery(sessionId: string, query: Record<string, string | undefined>): RunOptions {
  if (Object.keys(query).some(key => key !== 'limit' && key !== 'cursor') ||
    (query.limit !== undefined && !/^[1-5]$/.test(query.limit))) throw new AppError('INVALID_REQUEST');
  const options: RunOptions = {};
  if (query.limit !== undefined) options.limit = Number(query.limit);
  if (query.cursor !== undefined) {
    const position = decodeCursor(query.cursor, 'runs:' + sessionId);
    const key = position.beforePageKey;
    if (Object.keys(position).length !== 1 || typeof key !== 'number' || !Number.isSafeInteger(key) || key < 1) throw new AppError('INVALID_REQUEST');
    options.beforePageKey = key;
  }
  return options;
}
