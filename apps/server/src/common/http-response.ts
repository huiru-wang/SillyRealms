import type { ErrorCode } from './error-codes.js';

/** Public JSON response shape; transport status is chosen by the caller. */
export type ApiResponse<T> =
  | { code: 'OK'; message: string; data: T }
  | { code: ErrorCode; message: string; data: null };

export function ok<T>(data: T, message = ''): ApiResponse<T> {
  return { code: 'OK', message, data };
}

export function failure(code: ErrorCode, message: string): ApiResponse<never> {
  return { code, message, data: null };
}
