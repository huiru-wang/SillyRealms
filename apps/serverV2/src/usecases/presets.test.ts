import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database/connection.js';
import { PresetService } from '../modules/presets/service.js';
import { createImportPreset } from './import-preset.js';
import { createExportPreset } from './export-preset.js';

let db: DatabaseSync, presets: PresetService;
beforeEach(() => { db = openDatabase(':memory:'); presets = new PresetService(db); });
afterEach(() => db.close());

describe('portable preset usecases', () => {
  it('imports a validated document and chooses the first available legacy name suffix', () => {
    const importPreset = createImportPreset({ presets });
    const document = presets.toDocument({ ...presets.getDefault(), name: 'Imported' });
    const first = importPreset(document), second = importPreset(document), third = importPreset(document);
    expect([first.name, second.name, third.name]).toEqual(['Imported', 'Imported(1)', 'Imported(2)']);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(first.config).toMatchObject({ schemaVersion: 1, nodes: document.config_json.nodes });
    expect(first).not.toHaveProperty('config_json');
    presets.delete(second.id);
    expect(importPreset(document).name).toBe('Imported(1)');
    expect(document.name).toBe('Imported');
  });

  it('exports current data without persistence metadata and remains importable', () => {
    const created = presets.create(presets.getDefault());
    const updated = presets.update(created.id, { name: 'Current saved name', description: 'Saved edit' })!;
    const exported = createExportPreset({ presets })(created.id);
    expect(exported.filename).toBe('Current saved name.json');
    expect(exported.document).toMatchObject({ name: updated.name, description: updated.description, config_json: { schemaVersion: 3 } });
    expect(Object.keys(exported.document).sort()).toEqual(['config_json', 'context_strategy', 'description', 'model_parameters', 'name']);
    const imported = createImportPreset({ presets })(exported.document);
    expect(imported.name).toBe('Current saved name(1)');
    expect(imported.config).toEqual(updated.config);
    expect(() => createExportPreset({ presets })('missing')).toThrow('PRESET_NOT_FOUND');
  });

  it('rejects invalid document keys and invalid nodes before creating a preset', () => {
    const importPreset = createImportPreset({ presets });
    const document = presets.toDocument(presets.getDefault());
    expect(() => importPreset({ ...document, id: 'caller-id' })).toThrow();
    expect(() => importPreset({ ...document, context_strategy: { ...document.context_strategy, unknown: true } })).toThrow();
    document.config_json.nodes.reverse();
    expect(() => importPreset(document)).toThrow();
    expect(presets.list()).toEqual([]);
  });
});
