export type SettingsValues = {
  defaultPresetId: string | null;
  defaultApiModelConfigId: string | null;
};
export type SettingsDefaults = SettingsValues;
export type SettingsPatch = Partial<SettingsValues>;
export type AppSettings = SettingsValues & {
  id: 1;
  createdAt: number;
  updatedAt: number;
};
