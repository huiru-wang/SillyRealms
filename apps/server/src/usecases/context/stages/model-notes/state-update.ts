import type { StateUpdateOutput } from '../../../../modules/sessions/service.js';
import { record, serializeNoteJson } from './serialization.js';
import type { ModelNoteSource } from './types.js';

export const stateUpdateNotes: ModelNoteSource = {
  source: 'state-update',
  build(entry) {
    if (entry.type !== 'message' || entry.role !== 'assistant') return undefined;
    const output = record(record(entry.extData.output)?.stateUpdate);
    if (!output || (output.status !== 'success' && output.status !== 'partial_success') || !Array.isArray(output.updates)) return undefined;
    type AcceptedUpdate = Omit<Extract<StateUpdateOutput['updates'][number], { status: 'success' }>, 'status'>;
    const updates: AcceptedUpdate[] = [];
    for (const item of output.updates) {
      const update = record(item);
      if (!update || update.status !== 'success' || typeof update.path !== 'string' || !update.path.trim() ||
        !Object.hasOwn(update, 'value') || update.value === undefined ||
        (update.reason !== undefined && typeof update.reason !== 'string')) continue;
      updates.push({
        path: update.path, value: update.value as AcceptedUpdate['value'],
        ...(typeof update.reason === 'string' ? { reason: update.reason } : {}),
      });
    }
    if (!updates.length) return undefined;
    return [
      '<state_update>',
      ...updates.map(serializeNoteJson),
      '</state_update>',
    ].join('\n');
  },
};
