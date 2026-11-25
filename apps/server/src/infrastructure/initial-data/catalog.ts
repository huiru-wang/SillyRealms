import { lstatSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bundledRoot = fileURLToPath(new URL('../../../../../initial-data/', import.meta.url));
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/);
const filename = z.string().min(1).regex(/^[^/\\:\x00]+$/);
const manifestSchema = z.object({
  defaultPresetId: id,
  defaultReplyAssistPresetId: id.optional(),
  presets: z.array(z.object({ id, file: filename.endsWith('.json') }).strict()).min(1),
  worlds: z.array(z.object({ id, file: filename.endsWith('.zip') }).strict()),
}).strict();

type Entry = { id: string; file: string };
export type InitialWorld = Entry & { readBytes: () => Promise<Uint8Array> };
export type InitialData = {
  defaultPresetId: string;
  defaultReplyAssistPresetId?: string;
  presets: (Entry & { document: unknown })[];
  worlds: InitialWorld[];
};

export function resourceError(label: string, cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error('INITIAL_DATA_ERROR ' + label + ': ' + reason, { cause });
}

function checkedFile(directory: string, file: string): string {
  if (!lstatSync(directory).isDirectory()) throw new Error('expected a directory');
  const path = join(directory, file);
  if (!lstatSync(path).isFile()) throw new Error('expected a regular file');
  return path;
}

export function loadInitialData(root = bundledRoot): InitialData {
  try {
    const manifestPath = checkedFile(root, 'manifest.json');
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (!manifest.presets.some(preset => preset.id === manifest.defaultPresetId)) {
      throw new Error('unknown defaultPresetId ' + manifest.defaultPresetId);
    }

    if (manifest.defaultReplyAssistPresetId && !manifest.presets.some(preset => preset.id === manifest.defaultReplyAssistPresetId)) {
      throw new Error('unknown defaultReplyAssistPresetId ' + manifest.defaultReplyAssistPresetId);
    }

    function loadEntries<T>(group: 'presets' | 'worlds', load: (entry: Entry, path: string) => T): T[] {
      const seen = new Set<string>();
      const directory = join(root, group);
      return manifest[group].map(entry => {
        try {
          if (seen.has(entry.id)) throw new Error('duplicate ID');
          seen.add(entry.id);
          return load(entry, checkedFile(directory, entry.file));
        } catch (error) {
          throw resourceError(group + '/' + entry.file + ' (' + entry.id + ')', error);
        }
      });
    }

    return {
      defaultReplyAssistPresetId: manifest.defaultReplyAssistPresetId,
      defaultPresetId: manifest.defaultPresetId,
      presets: loadEntries('presets', (entry, path) => ({
        ...entry, document: JSON.parse(readFileSync(path, 'utf8')) as unknown,
      })),
      worlds: loadEntries('worlds', entry => ({
        ...entry, readBytes: async () => readFile(checkedFile(join(root, 'worlds'), entry.file)),
      })),
    };
  } catch (error) {
    throw resourceError('manifest.json', error);
  }
}
