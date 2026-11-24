import {i18n} from './instance.ts';

/** A stable code/key stays usable in a string-only display projection. */
export function errorKey(reason: unknown, fallbackKey = 'errors:unexpected'): string {
  if (typeof reason === 'object' && reason !== null && 'errorCode' in reason &&
      typeof (reason as {errorCode: unknown}).errorCode === 'string') {
    return (reason as {errorCode: string}).errorCode;
  }
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return fallbackKey;
}
/** Translate at the display boundary so an existing error follows a language change. */
export function errorMessage(reason: unknown, fallbackKey = 'errors:unexpected'): string {
  if (reason === null || reason === undefined || reason === '') return '';
  const value = errorKey(reason, fallbackKey);
  const parts = value.split('；');
  if (parts.length > 1 && parts.some(part => i18n.exists('errors:codes.' + part) || /^(common|sessions|settings|worlds|presets|models|stage|errors):/.test(part))) {
    return parts.map(part => errorMessage(part, fallbackKey))
      .join(i18n.resolvedLanguage === 'zh-CN' ? '；' : i18n.resolvedLanguage === 'ja' ? ' ' : '; ');
  }
  const codeKey = 'errors:codes.' + value;
  if (i18n.exists(codeKey)) return i18n.t(codeKey);
  if (/^(common|sessions|settings|worlds|presets|models|stage|errors):/.test(value)) {
    return i18n.exists(value) ? i18n.t(value) : i18n.t(fallbackKey);
  }
  if (typeof reason === 'object' && reason !== null && 'errorCode' in reason) return i18n.t(fallbackKey);
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return i18n.t(fallbackKey);
  return value;
}
