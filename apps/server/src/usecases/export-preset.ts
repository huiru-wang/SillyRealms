import type { PresetDocument, PresetReader } from '../modules/presets/service.js';

export type ExportPresetResult = { filename: string; document: PresetDocument };
export type ExportPreset = (id: string) => ExportPresetResult;

export function createExportPreset({ presets }: { presets: PresetReader }): ExportPreset {
  return id => {
    const preset = presets.require(id);
    return { filename: preset.name + '.json', document: presets.toDocument(preset) };
  };
}
