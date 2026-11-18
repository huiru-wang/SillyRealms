export type SettingsValues = {
  default_preset_id: string | null;
  default_api_model_config_id: string | null;
};
export type SettingsPatch = Partial<SettingsValues>;
export type AppSettings = SettingsValues & {
  id: 1;
  created_at: number;
  updated_at: number;
};
