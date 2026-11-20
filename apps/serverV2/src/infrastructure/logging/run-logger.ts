export type RunLogSink = (line: string) => void;
export type RunLogger = (event: string, data?: Record<string, unknown>, timestamp?: number) => void;

const credentialKeys = new Set([
  'apikey', 'xapikey', 'authorization', 'proxyauthorization', 'cookie', 'setcookie',
  'credentialref', 'accesstoken', 'refreshtoken', 'apitoken', 'bearertoken', 'clientsecret', 'privatekey', 'password',
]);
const sensitive = (key: string) => credentialKeys.has(key.replace(/[-_]/g, '').toLowerCase());
const singleLine = (value: string) => value.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Build plain data first: custom toJSON methods cannot bypass credential filtering. */
function logValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return String(value);
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return '[Circular]';
  ancestors.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
    if (Array.isArray(value)) return value.map(item => logValue(item, ancestors));
    const output: Record<string, unknown> = Object.create(null);
    const keys = new Set(Object.keys(value));
    if (value instanceof Error) {
      for (const key of ['name', 'message', 'stack', 'cause']) if (key in value) keys.add(key);
    }
    for (const key of keys) {
      if (sensitive(key)) { output[key] = '[REDACTED]'; continue; }
      try { output[key] = logValue((value as Record<string, unknown>)[key], ancestors); }
      catch { output[key] = '[Unserializable]'; }
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function localTime(timestamp: number): string {
  let date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) date = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One physical line per observation; logging has no authority over a run's outcome. */
export function createRunLogger(identity: { runId: string; sessionId: string },
  sink: RunLogSink = line => console.log(line)): RunLogger {
  const { runId, sessionId } = identity;
  return (event, data = {}, timestamp = Date.now()) => {
    try {
      let json: string;
      try {
        const normalized = logValue(data) as Record<string, unknown>;
        const fields = [`"runId":${JSON.stringify(runId)}`, `"sessionId":${JSON.stringify(sessionId)}`];
        for (const [key, value] of Object.entries(normalized)) {
          if (key === 'runId' || key === 'sessionId') continue;
          const serialized = JSON.stringify(value);
          if (serialized !== undefined) fields.push(`${JSON.stringify(key)}:${serialized}`);
        }
        json = `{${fields.join(',')}}`;
      } catch {
        json = JSON.stringify({ runId, sessionId, loggingError: 'serialization_failed' });
      }
      const label = singleLine(JSON.stringify(event).slice(1, -1))
        .replace(/\[/g, '\\u005b').replace(/\]/g, '\\u005d');
      void Promise.resolve(sink(`[${localTime(timestamp)}] [${label}] [${singleLine(json)}]`)).catch(() => {});
    } catch { /* Serialization and sink failures must never change business execution. */ }
  };
}
