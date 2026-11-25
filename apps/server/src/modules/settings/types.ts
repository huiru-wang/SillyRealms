import type { AppLocale } from '@sillyrealms/sdk/locale';

export type SettingsValues = {
  locale: AppLocale;
  defaultReplyAssistPresetId: string | null;
  defaultPresetId: string | null;
  defaultApiModelConfigId: string | null;
};
export type SettingsDefaults = Omit<SettingsValues, 'locale' | 'defaultReplyAssistPresetId'> & { defaultReplyAssistPresetId?: string | null; locale?: AppLocale };
export type SettingsPatch = Partial<SettingsValues>;
export type AppSettings = SettingsValues & {
  id: 1;
  createdAt: number;
  updatedAt: number;
};
