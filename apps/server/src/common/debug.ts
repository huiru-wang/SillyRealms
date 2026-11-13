import { AsyncLocalStorage } from 'node:async_hooks';

export type DebugContext = { sessionId?: string; runId?: string; requestId?: string; requestIndex?: number; phase?: string };
const context = new AsyncLocalStorage<DebugContext>();
export const debugEnabled = () => process.env.SILLYREALMS_DEBUG === '1';
export function withDebugContext<T>(scope: DebugContext, work: () => T): T {
  return context.run({ ...context.getStore(), ...scope }, work);
}
const privateField = /^(authorization|proxyauthorization|cookie|setcookie|apikey|xapikey|apitoken|xauthtoken|accesskey|accesskeyid|secretaccesskey|password|passwd|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|credential|credentials|credentialref)$/i;
type DebugOptions = { context?: DebugContext; secrets?: readonly string[] };

/** One physical line per record. Explicit debug mode includes narrative content, never credentials. */
export function debugLog(title: string, detail: unknown, options: DebugOptions = {}): void {
  if (debugEnabled()) writeLog(title, detail, options, 'log');
}
/** Existing operational warnings remain visible even when content debugging is disabled. */
export function warnLog(title: string, detail: unknown): void {
  writeLog(title, detail, {}, 'warn');
}
function writeLog(title: string, detail: unknown, options: DebugOptions, level: 'log' | 'warn'): void {
  try {
    const ancestors: object[] = [];
    const secrets = (options.secrets ?? []).filter(Boolean).flatMap(secret => [secret, encodeURIComponent(secret)]);
    const redact = (text: string) => {
      for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
      return text;
    };
    const json = JSON.stringify(detail, function (key, value: unknown) {
      if (privateField.test(key.replace(/[-_]/g, ''))) return '[REDACTED]';
      if (typeof value === 'string') return redact(value);
      if (typeof value === 'bigint') return String(value);
      if (value && typeof value === 'object') {
        while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
        if (ancestors.includes(value)) return '[Circular]';
        ancestors.push(value);
        if (value instanceof Error) return { name: value.name, message: value.message };
      }
      return value;
    }) ?? 'null';
    const data = detail && typeof detail === 'object' ? detail as DebugContext : {};
    const scope = { ...context.getStore() };
    for (const [name,value] of Object.entries(options.context ?? {}))
      if (value !== undefined) Object.assign(scope, { [name]: value });
    for (const name of ['sessionId', 'runId', 'requestId', 'requestIndex', 'phase'] as const)
      if (data[name] !== undefined) Object.assign(scope, { [name]: data[name] });
    const tags = Object.entries(scope).filter(([,value]) => value !== undefined)
      .map(([name,value]) => `${name}=${JSON.stringify(typeof value === 'string' ? redact(value) : value)}`).join(' ');
    const marker = title === 'RUN BEGIN' ? '╔═' : title === 'RUN END' ? '╚═'
      : title === 'MODEL BEGIN' ? '├▶' : title === 'MODEL END' ? '└■' : '│ ';
    const label = title.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
    // JSON escapes embedded newlines; also escape JS line separators for line-oriented readers.
    const line = `${new Date().toISOString()} ${marker} ${label}${tags ? ' ' + tags : ''} | ${json}`
      .replace(/[\u007f-\u009f\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4,'0'));
    console[level](line);
  } catch { /* Debug serialization or a closed output stream must never fail a Run. */ }
}
