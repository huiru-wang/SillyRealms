import {createInstance, type i18n as I18n} from 'i18next';
import {initReactI18next} from 'react-i18next';
import {DEFAULT_LOCALE, SUPPORTED_LOCALES, isAppLocale, type AppLocale} from '@sillyrealms/sdk/locale';
import {commonZh, commonEn, commonJa} from './locales/common.ts';
import {sessionsZh, sessionsEn, sessionsJa} from './locales/sessions.ts';
import {settingsZh, settingsEn, settingsJa} from './locales/settings.ts';
import {errorsZh, errorsEn, errorsJa} from './locales/errors.ts';
import {managementZh, managementEn, managementJa} from './locales/management.ts';
import {stageZh, stageEn, stageJa} from './locales/stage.ts';

export const resources = {
  'zh-CN': {common: commonZh, sessions: sessionsZh, settings: settingsZh, errors: errorsZh, ...managementZh, stage: stageZh},
  en: {common: commonEn, sessions: sessionsEn, settings: settingsEn, errors: errorsEn, ...managementEn, stage: stageEn},
  ja: {common: commonJa, sessions: sessionsJa, settings: settingsJa, errors: errorsJa, ...managementJa, stage: stageJa},
};

/** Each document owns an instance; frames receive their language from the trusted Host. */
export function createI18n(locale: AppLocale = DEFAULT_LOCALE): I18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: locale, supportedLngs: [...SUPPORTED_LOCALES], fallbackLng: DEFAULT_LOCALE,
    load: 'currentOnly', defaultNS: 'common', resources,
    initAsync: false, interpolation: {escapeValue: false}, react: {useSuspense: false},
  });
  return instance;
}
export const i18n = createI18n();
export function currentLocale(): AppLocale {
  return isAppLocale(i18n.resolvedLanguage) ? i18n.resolvedLanguage : DEFAULT_LOCALE;
}
/** Only apply a confirmed server setting. No browser language or localStorage preference. */
export async function applyLocale(locale: AppLocale): Promise<void> {
  await i18n.changeLanguage(locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}
