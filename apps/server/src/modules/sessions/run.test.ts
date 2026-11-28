import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../infrastructure/database/connection.js';
import { aggregateUsage, decodeCapabilities, runMetricsSchema } from './run.js';

describe('v15 run storage', () => {
  it('preserves missing capabilities and isolates malformed results', () => {
    expect(decodeCapabilities('{}')).toEqual({});
    const suggestions = { status: 'success', items: ['Continue'] };
    expect(decodeCapabilities(JSON.stringify({ stateUpdate: null, actionSuggestions: suggestions }))).toEqual({
      stateUpdate: { status: 'processing_error', updates: [], errors: [{errorCode:'STATE_UPDATE_STORED_RESULT_INVALID'}] },
      actionSuggestions: suggestions,
    });
  });

  it('counts successful unknown requests, rejects duplicate main/summary IDs and invalid context references', () => {
    const request = { requestId:'q', provider:'p', modelId:'m', usage:null };
    const main = { requests:[request] };
    expect(aggregateUsage([{main,summaries:{}}])).toMatchObject({recordedRequestCount:1, unknownUsageRequestCount:1});
    expect(() => aggregateUsage([{main,summaries:{c:main}}])).toThrow('DUPLICATE_REQUEST_METRICS');
    expect(() => runMetricsSchema.parse({main:{ ...main, context:{
      requestId:'missing', apiModelConfigId:'model', contextWindowTokens:100,
      contextComposition:{systemBytes:0,historyBytes:0,summaryBytes:0},
    } }, summaries:{}})).toThrow();
  });

  it('uses bounded run and message indexes and introduces no foreign key for runs', () => {
    const db = openDatabase(':memory:');
    try {
      expect(db.prepare('PRAGMA foreign_key_list(runs)').all()).toEqual([]);
      expect(db.prepare('PRAGMA foreign_key_list(entries)').all().map(row => row.table)).toEqual(['sessions']);
      expect(db.prepare('PRAGMA table_info(entries)').all().map(row => row.name)).not.toContain('metrics_json');
      const plans = [
        ["SELECT * FROM runs WHERE session_id='s' AND page_key<123 ORDER BY page_key DESC LIMIT 6", 'idx_runs_session_page'],
        ["SELECT * FROM entries WHERE session_id='s' AND type='message' AND run_id IN ('r1','r2') ORDER BY run_id,seq", 'idx_entries_run'],
      ] as const;
      for (const [sql,index] of plans) {
        const details = db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map(row => row.detail).join('\n');
        expect(details).toContain(index);
      }
    } finally { db.close(); }
  });
});
