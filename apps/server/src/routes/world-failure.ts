import { storedError } from '../domain/world-card.js';
import { failure } from '../common/http-response.js';

/** Translate stored card-validation errors into the public HTTP envelope. */
export function worldFailure(error: unknown) {
  const { code, details } = storedError(error);
  return failure(code, `${details.path}: ${details.reason}`, details);
}
