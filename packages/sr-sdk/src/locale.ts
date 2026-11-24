/** Application language metadata; safe to import without React or browser globals. */
export const SUPPORTED_LOCALES = ['zh-CN', 'en', 'ja'] as const;
export type AppLocale = typeof SUPPORTED_LOCALES[number];
export const DEFAULT_LOCALE: AppLocale = 'zh-CN';
export const languageNames: Record<AppLocale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
  ja: '日本語',
};
export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'zh-CN' || value === 'en' || value === 'ja';
}
