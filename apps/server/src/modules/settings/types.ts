import type { AppLocale } from '@sillyrealms/sdk/locale';

export type SettingsValues = {
  locale: AppLocale;
  defaultPresetId: string | null;
  defaultApiModelConfigId: string | null;
};
export type SettingsDefaults = Omit<SettingsValues, 'locale'> & { locale?: AppLocale };
export type SettingsPatch = Partial<SettingsValues>;
export type AppSettings = SettingsValues & {
  id: 1;
  createdAt: number;
  updatedAt: number;
};
