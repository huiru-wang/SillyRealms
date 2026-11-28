import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject, JsonValue } from '../infrastructure/database/connection.js';
import type { NarrativeOutput, RequestMetrics } from '../modules/sessions/service.js';
import type { Services } from '../services.js';

const emptyOutput: NarrativeOutput = {
  stateUpdate: { status: 'no_updates', updates: [] }, actionSuggestions: { status: 'no_suggestions', items: [] },
};

export function storedMetrics(db: DatabaseSync, runId: string) {
  const row = db.prepare('SELECT metrics_json FROM runs WHERE id=?').get(runId);
  if (!row) throw new Error('Missing fixture run: ' + runId);
  return JSON.parse(String(row.metrics_json)) as { main: RequestMetrics | null; summaries: Record<string, RequestMetrics> };
}

type FixtureEntry = {
  id?: string; runId: string; role: 'user' | 'assistant' | null; type: 'message' | 'compaction'; payload: JsonObject;
  timestamp?: number; parentId?: string | null; state?: JsonValue[] | null;
  extData?: { summary?: { coveredThroughEntryId: string; sourceHash: string } };
};

// Construct persisted histories through the same opening, admission, regeneration and settlement operations as a session.
export function seedMessage(services: Services, sessionId: string, input: FixtureEntry, output: NarrativeOutput = emptyOutput) {
  const { sessions, cache } = services, session = sessions.require(sessionId);
  const id = input.id ?? randomUUID(), tip = session.tipEntryId;
  const parentId = input.parentId === undefined ? tip : input.parentId;
  const previous = tip ? sessions.getEntry(sessionId, tip) : null;
  const message = input.payload.message;
  const timestamp = input.timestamp ?? (message && typeof message === 'object' && !Array.isArray(message) ? Number(message.timestamp) : Date.now());
  const entry = { id, parentId, timestamp, payload: input.payload, state: input.state ?? null };
  if (input.type === 'compaction') {
    if (!previous) throw new Error('A fixture summary requires a parent');
    return sessions.appendSummary(sessionId, { id, parentId: previous.id, runId: previous.runId, text: String(input.payload.summary),
      coveredThroughEntryId: input.extData?.summary?.coveredThroughEntryId ?? previous.id,
      sourceHash: input.extData?.summary?.sourceHash ?? '0'.repeat(64), metrics: null });
  }
  if (input.role === 'assistant' && !tip) {
    sessions.createOpening(sessionId, input.runId, entry, output);
  } else {
    const retry = previous?.role === 'user' && previous.runId === input.runId && input.role === 'assistant';
    const runId = input.runId;
    const permit = cache.acquireRun({ sessionId, worldId: session.worldId, runId });
    try {
      if (retry) {
        const old = sessions.getRun(sessionId, runId);
        sessions.restartRun(sessionId, runId, old.assistantEntryId, id, previous.id, permit);
      } else {
        const user = input.role === 'user' ? entry : {
          id: id + '-user', timestamp, parentId, payload: { message: { role: 'user', content: '继续', timestamp } },
        };
        const assistantId = input.role === 'user' ? randomUUID() : id;
        sessions.beginRun(sessionId, runId, assistantId, user, permit);
        if (input.role === 'user') {
          sessions.settleRun(sessionId, runId, assistantId, 'cancelled', null, null, null, permit);
          return sessions.getEntry(sessionId, id)!;
        }
      }
      sessions.settleRun(sessionId, runId, id, null, { ...entry, parentId: sessions.require(sessionId).tipEntryId }, output, null, permit);
    } finally { cache.releaseRun(permit); }
  }
  return sessions.getEntry(sessionId, id)!;
}
