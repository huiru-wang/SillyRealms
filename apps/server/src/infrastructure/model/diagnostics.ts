import type { ModelDiagnostic, ModelOptions } from './client.js';

const sensitiveKeys = new Set([
  'apikey', 'xapikey', 'authorization', 'proxyauthorization', 'cookie', 'setcookie',
  'credentialref', 'accesstoken', 'refreshtoken', 'apitoken', 'bearertoken', 'clientsecret', 'privatekey', 'password',
]);

/** Detach before observing so a logger cannot mutate the request or authoritative SDK response. */
function safeData(value: unknown, secrets: readonly string[], ancestors = new Set<object>()): unknown {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return '[' + typeof value + ']';
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => safeData(item, secrets, ancestors));
    const fields = value instanceof Error
      ? { ...value, name: value.name, message: value.message, stack: value.stack }
      : value;
    return Object.fromEntries(Object.entries(fields).map(([key, item]) => [
      key, sensitiveKeys.has(key.replace(/[-_]/g, '').toLowerCase()) ? '[REDACTED]' : safeData(item, secrets, ancestors),
    ]));
  } finally { ancestors.delete(value); }
}

/** Diagnostics are best effort and cannot affect provider requests, cancellation or settlement. */
export function emitModelDiagnostic(options: Pick<ModelOptions, 'apiKey' | 'onDiagnostic'>, event: ModelDiagnostic): void {
  if (!options.onDiagnostic) return;
  let data: unknown;
  try {
    const secrets = [...new Set([options.apiKey, options.apiKey.trim()])].filter(Boolean);
    data = safeData(event.data, secrets);
  } catch { data = { unavailable: 'diagnostic_serialization_failed' }; }
  try {
    // A user-provided async observer must not create an unhandled rejection either.
    void Promise.resolve(options.onDiagnostic({ ...event, data })).catch(() => {});
  } catch { /* Logging cannot change model execution. */ }
}
