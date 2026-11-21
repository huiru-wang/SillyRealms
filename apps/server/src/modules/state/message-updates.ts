import { isDeepStrictEqual } from 'node:util';
import { StateValidationError } from '@sillyrealms/sdk/state-validation';
import type { JsonValue } from '../../infrastructure/database/connection.js';
import { parseStatePath, prepareStatePatch } from './patch.js';
import { messageValues, replaceMessageValue } from './snapshot.js';
import type { AcceptedMessageUpdate, MessageUpdateResult, PreparedMessageUpdates } from './types.js';

function isUpdate(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.hasOwn(value, 'path') && Object.hasOwn(value, 'value')
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.keys(value).every(key => key === 'path' || key === 'value' || key === 'reason');
}

function rejected(error: unknown, path?: string): MessageUpdateResult {
  if (!(error instanceof StateValidationError)) {
    return { status: 'processing_error', ...(path === undefined ? {} : { path }), errorCode: 'STATE_UPDATE_PROCESSING_FAILED' };
  }
  const invalidPath = error.code === 'INVALID_STATE_PATH' || error.code === 'STATE_NOT_FOUND'
    || error.code === 'STATE_ROOT_NOT_ACTIVE';
  return {
    status: invalidPath ? 'invalid_path' : 'invalid_value',
    ...(path === undefined ? {} : { path }),
    errorCode: error.code, statePath: error.path,
    ...(error.rulePath === undefined ? {} : { rulePath: error.rulePath }),
  };
}

/** Candidate-only row isolation: no accepted row is published until normalization succeeds. */
export function prepareMessageUpdates(
  inherited: JsonValue[] | null, definition: JsonValue | null,
  allowedRoots: readonly string[], input: readonly unknown[],
): Omit<PreparedMessageUpdates, 'change'> {
  const allowed = new Set(allowedRoots), updates: AcceptedMessageUpdate[] = [], results: MessageUpdateResult[] = [];
  let snapshot = inherited;
  for (const row of input) {
    let path: string | undefined;
    try {
      if (!isUpdate(row)) {
        results.push({ status: 'invalid_update', errorCode: 'INVALID_STATE_UPDATE' });
        continue;
      }
      const rowPath = row.path;
      if (typeof rowPath !== 'string') throw new StateValidationError('INVALID_STATE_PATH', 'message');
      const parts = parseStatePath(rowPath, 'message');
      path = rowPath;
      const reason = row.reason;
      if (Object.hasOwn(row, 'reason') && typeof reason !== 'string') {
        results.push({ path, status: 'invalid_update', errorCode: 'INVALID_STATE_UPDATE' });
        continue;
      }
      const root = parts[0]!;
      if (!allowed.has(root)) throw new StateValidationError('STATE_ROOT_NOT_ACTIVE', 'message', path);
      const value = row.value as JsonValue;
      const prepared = prepareStatePatch(messageValues(snapshot, root), definition, 'message',
        { path, value }, { requireExisting: true });
      const accepted: AcceptedMessageUpdate = structuredClone({
        path, value,
        ...(reason === undefined ? {} : { reason: reason as string }),
      });
      const candidate = prepared.changed
        ? replaceMessageValue(snapshot!, root, prepared.snapshot[root]!)
        : snapshot;
      // Rows that throw above do not mutate snapshot or the accepted output records.
      updates.push(accepted);
      results.push({ status: 'success', path });
      snapshot = candidate;
    } catch (error) {
      results.push(rejected(error, path));
    }
  }
  return { snapshot, changed: !isDeepStrictEqual(inherited, snapshot), updates, results };
}
