import { AppError } from '../errors.js';
import type { TransactionRunner } from '../infrastructure/database/transaction.js';
import type { PresetService } from '../modules/presets/service.js';
import type { SessionService } from '../modules/sessions/service.js';
import type { SettingsService } from '../modules/settings/service.js';
import type { WorldService } from '../modules/worlds/service.js';

type Dependencies = {
  presets: Pick<PresetService, 'delete'>;
  settings: Pick<SettingsService, 'getOptional'>;
  worlds: Pick<WorldService, 'listUsingDefaultPreset'>;
  sessions: Pick<SessionService, 'listUsingPreset'>;
};

function referenceNames(items: { id: string; name: string | null }[]): string {
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const { name } of items) {
    if (!name) continue;
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return items.map(({ id, name }) => {
    if (!name) return '“未命名会话”（' + id + '）';
    return '“' + name + '”' + (duplicates.has(name) ? '（' + id + '）' : '');
  }).join('、');
}

export function createDeletePreset(
  { presets, settings, worlds, sessions }: Dependencies,
  transaction: TransactionRunner,
) {
  return (id: string) => transaction(() => {
    const locations: string[] = [];
    if (settings.getOptional()?.defaultPresetId === id) locations.push('应用设置中的默认预设');
    const worldRefs = worlds.listUsingDefaultPreset(id);
    if (worldRefs.length) locations.push('世界卡' + referenceNames(worldRefs) + '的默认预设');
    const sessionRefs = sessions.listUsingPreset(id);
    if (sessionRefs.length) locations.push('会话' + referenceNames(sessionRefs) + '的叙事预设');
    if (locations.length) throw new AppError('REFERENCE_CONFLICT', locations.join('；'));
    if (!presets.delete(id)) throw new AppError('PRESET_NOT_FOUND');
  });
}
