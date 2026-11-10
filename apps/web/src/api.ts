export class ApiError extends Error {
  constructor(public errorCode: string, public errorMessage: string) {
    super(errorMessage);
    this.name = 'ApiError';
  }
}

type ApiEnvelope<T> =
  | { success: true; errorCode: null; errorMessage: ''; data: T }
  | { success: false; errorCode: string; errorMessage: string; data: unknown };

function isApiEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return typeof result.success === 'boolean' && 'data' in result &&
    (result.success
      ? result.errorCode === null && result.errorMessage === ''
      : typeof result.errorCode === 'string' && !!result.errorCode &&
        typeof result.errorMessage === 'string' && !!result.errorMessage);
}

/** Preserve business payloads, hiding only the four-field HTTP envelope. */
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/' + path, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? {'content-type': 'application/json'} : {}),
      ...options.headers,
    },
  });
  const result: unknown = await response.json().catch(() => null);
  if (!isApiEnvelope(result)) throw new ApiError('INVALID_RESPONSE', '服务器响应格式无效');
  if (!result.success) throw new ApiError(result.errorCode, result.errorMessage);
  if (!response.ok) throw new ApiError('INVALID_RESPONSE', '服务器响应状态异常');
  return result.data as T;
}

export const json = (data: unknown) => JSON.stringify(data);
