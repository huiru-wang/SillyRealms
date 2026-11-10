import { ErrorMessages, type ErrorCode } from '../../common/error-codes.js';

export class RuntimeError extends Error {
  constructor(public code: ErrorCode, public details?: Record<string, string>) {
    super(ErrorMessages[code]);
    this.name = 'RuntimeError';
  }
}
