import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { ModelService } from '../models/service.js';
import { PresetService } from './service.js';

let db: DatabaseSync, presets: PresetService;
beforeEach(() => { db = openDatabase(':memory:'); presets = new PresetService(db, new ModelService(db)); });
afterEach(() => db.close());

describe('portable preset documents', () => {
  it('imports a validated document and chooses the first available name suffix', () => {
    const document = presets.toDocument({ ...presets.getDefault(), name: 'Imported' });
    const first = presets.importDocument(document), second = presets.importDocument(document), third = presets.importDocument(document);
    expect([first.name, second.name, third.name]).toEqual(['Imported', 'Imported(1)', 'Imported(2)']);
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(first.config).toMatchObject({ schemaVersion: 1, nodes: document.config.nodes });
    expect(first).not.toHaveProperty('config_json');
    presets.delete(second.id);
    expect(presets.importDocument(document).name).toBe('Imported(1)');
    expect(document.name).toBe('Imported');
  });

  it('exports current data without persistence metadata and remains importable', () => {
    const created = presets.create(presets.getDefault());
    const updated = presets.update(created.id, { name: 'Current saved name', description: 'Saved edit' })!;
    const document = presets.toDocument(updated);
    expect(document).toMatchObject({ name: updated.name, description: updated.description, config: { schemaVersion: 1 } });
    expect(Object.keys(document).sort()).toEqual(['config', 'description', 'name', 'type']);
    const imported = presets.importDocument(document);
    expect(imported.name).toBe('Current saved name(1)');
    expect(imported.config).toEqual(updated.config);
  });

  it('rejects invalid document keys and invalid nodes before creating a preset', () => {
    const document = presets.toDocument(presets.getDefault());
    expect(() => presets.importDocument({ ...document, id: 'caller-id' })).toThrow();
    expect(() => presets.importDocument({ ...document, config: { ...document.config, unknown: true } })).toThrow();
    const { type, ...untyped } = document;
    expect(() => presets.importDocument(untyped)).toThrow();
    expect(() => presets.importDocument({ type, name: document.name, config_json: { schemaVersion: 3, nodes: document.config.nodes } })).toThrow();
    expect(() => presets.importDocument({ ...document, apiModelConfigId: 'local-only' })).toThrow();
    document.config.nodes.reverse();
    expect(() => presets.importDocument(document)).toThrow();
    expect(presets.list()).toEqual([]);
  });
});
