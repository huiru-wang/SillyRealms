import type { z } from 'zod';
import type { presetValueSchema } from './schema.js';

export type PresetValue = z.output<typeof presetValueSchema>;
export type CreatePresetInput = z.input<typeof presetValueSchema> & { id?: string };
export type UpdatePresetInput = Partial<z.input<typeof presetValueSchema>>;
export type PresetListOptions = { type?: 'narrative'; limit?: number; offset?: number };
export type Preset = PresetValue & {
  id: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type PresetSummary = Omit<Preset, 'config'>;
export type PresetPage = { items: PresetSummary[]; hasMore: boolean };
