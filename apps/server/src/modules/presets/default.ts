import { resourceError, type InitialData } from '../../infrastructure/initial-data/catalog.js';
import { presetDocumentSchema } from './schema.js';

export function builtinPresets(catalog: InitialData) {
  return new Map(catalog.presets.map(({ id, file, document }) => {
    try {
      return [id, { file, value: presetDocumentSchema.parse(document) }] as const;
    } catch (error) {
      throw resourceError('presets/' + file + ' (' + id + ')', error);
    }
  }));
}
