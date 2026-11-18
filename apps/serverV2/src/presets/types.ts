import type { z } from 'zod';
import type { presetValueSchema } from './schema.js';

export type PresetValue = z.output<typeof presetValueSchema>;
export type CreatePresetInput = z.input<typeof presetValueSchema> & { id?: string };
export type UpdatePresetInput = Partial<z.input<typeof presetValueSchema>>;
export type PresetListOptions = { type?: 'narrative'; limit?: number; offset?: number };
export type Preset = PresetValue & {
  id: string;
  created_at: number;
  updated_at: number;
};
