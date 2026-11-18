import type { z } from 'zod';
import type { presetValueSchema } from './schema.js';

export type PresetValue = z.output<typeof presetValueSchema>;
export type CreatePresetInput = z.input<typeof presetValueSchema> & { id?: string };
export type UpdatePresetInput = Partial<z.input<typeof presetValueSchema>>;
export type PresetListOptions = { type?: 'narrative'; limit?: number; offset?: number };
export type Preset = PresetValue & {
  id: string;
  createdAt: number;
  updatedAt: number;
};
export type PresetPage = { items: Preset[]; hasMore: boolean };
