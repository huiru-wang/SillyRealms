import { record, serializeNoteJson } from './serialization.js';
import type { ModelNoteSource } from './types.js';

export const stateUpdateNotes: ModelNoteSource = {
  source: 'state-update',
  build(entry) {
    if (entry.type !== 'message' || entry.role !== 'assistant') return undefined;
    const output = record(record(entry.extData.output)?.stateUpdate);
    const rows = (output?.status === 'success' || output?.status === 'partial_success') && Array.isArray(output.updates)
      ? output.updates : [];
    const lines = ['<state_update>'];
    for (const item of rows) {
      const update = record(item);
      if (!update || update.status !== 'success' || typeof update.path !== 'string' || !update.path.trim() ||
        !Object.hasOwn(update, 'value') || update.value === undefined ||
        (update.reason !== undefined && typeof update.reason !== 'string')) continue;
      try {
        lines.push(serializeNoteJson({
          path: update.path, value: update.value,
          ...(typeof update.reason === 'string' ? { reason: update.reason } : {}),
        }));
      } catch { /* Skip a malformed historical row while retaining the other successful updates. */ }
    }
    lines.push('</state_update>');
    return lines.join('\n');
  },
};
