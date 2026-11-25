import type { AppLocale } from '@sillyrealms/sdk/locale';

export type SettingsValues = {
  locale: AppLocale;
  coverMosaicDensity: number;
  defaultReplyAssistPresetId: string | null;
  defaultPresetId: string | null;
  defaultApiModelConfigId: string | null;
};
export type SettingsDefaults = Omit<SettingsValues, 'locale' | 'defaultReplyAssistPresetId' | 'coverMosaicDensity'> & { defaultReplyAssistPresetId?: string | null; locale?: AppLocale; coverMosaicDensity?: number };
export type SettingsPatch = Partial<SettingsValues>;
export type AppSettings = SettingsValues & {
  id: 1;
  createdAt: number;
  updatedAt: number;
};
