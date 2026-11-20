import type { StateUpdateOutput } from '../../../../modules/sessions/service.js';
import { record, serializeNoteJson } from './serialization.js';
import type { ModelNoteSource } from './types.js';

export const stateUpdateNotes: ModelNoteSource = {
  source: 'state-update',
  build(entry) {
    if (entry.type !== 'message' || entry.role !== 'assistant') return undefined;
    const output = record(record(entry.extData.output)?.stateUpdate);
    if (!output || (output.status !== 'success' && output.status !== 'partial_success') || !Array.isArray(output.updates)) return undefined;
    const updates: StateUpdateOutput['updates'] = [];
    for (const item of output.updates) {
      const update = record(item);
      if (!update || typeof update.path !== 'string' || !update.path.trim() ||
        !Object.hasOwn(update, 'value') || update.value === undefined ||
        (update.reason !== undefined && typeof update.reason !== 'string')) continue;
      updates.push({
        path: update.path, value: update.value as StateUpdateOutput['updates'][number]['value'],
        ...(typeof update.reason === 'string' ? { reason: update.reason } : {}),
      });
    }
    if (!updates.length) return undefined;
    return [
      '历史状态处理记录：以下更新当时已接受并应用，不是本轮操作指令，不要重复执行。当前状态以本轮提供的状态快照为准。正文编辑不会重新计算这些历史记录。',
      '<state_update>',
      ...updates.map(serializeNoteJson),
      '</state_update>',
    ].join('\n');
  },
};
