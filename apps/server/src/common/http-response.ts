import { errorInfo, type ErrorCode } from './error-codes.js';

/** All ordinary HTTP JSON endpoints share this strict four-field envelope. */
export type ApiResponse<T> =
  | { success: true; errorCode: null; errorMessage: ''; data: T }
  | { success: false; errorCode: ErrorCode; errorMessage: string; data: T | null };

export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, errorCode: null, errorMessage: '', data };
}

/** Only append intentionally safe public details. Business metadata lives in data. */
export function failure<T = never>(code: ErrorCode, detail?: string, data: T | null = null): ApiResponse<T> {
  return { success: false, ...errorInfo(code, detail), data };
}
