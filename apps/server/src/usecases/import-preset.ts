import type { Preset, PresetService } from '../modules/presets/service.js';

export type ImportPreset = (document: unknown) => Preset;

export function createImportPreset({ presets }: { presets: PresetService }): ImportPreset {
  return document => presets.importDocument(document);
}
