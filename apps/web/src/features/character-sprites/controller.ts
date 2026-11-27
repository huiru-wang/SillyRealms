import type {CharacterSpriteChangedEvent, Entry, StoredRun} from '../../../../../packages/sr-sdk/src/stage-contract.ts';
import type {HttpRequest} from '../../transport/http.ts';
import type {HistoryController} from '../history/index.ts';
import {appliedItems, type DisplaySprite} from './items.ts';

type Frame = {messageId: string; items: DisplaySprite[]};
export type SpriteDisplay = {enabled: boolean; frame: Frame | null};
type Options = {
  sessionId: string; request: HttpRequest; history: HistoryController;
  readTip: (signal: AbortSignal) => Promise<string | null>; changed: () => void;
};

export function createSpriteController({sessionId, request, history, readTip, changed}: Options) {
  const preference = 'sr:session:' + sessionId + ':show-character-sprites';
  let enabled = true;
  try { enabled = localStorage.getItem(preference) !== 'false'; } catch { /* Optional browser preference. */ }
  let view: SpriteDisplay = {enabled, frame: null};
  let world: string | null = null, revision = 0;
  let verifiedTip: string | null = null;
  let restoreRead: AbortController | null = null;
  const deleted = new Set<string>();
  const update = (patch: Partial<SpriteDisplay>) => { view = {...view, ...patch}; changed(); };
  function invalidate() {
    revision++;
    verifiedTip = null;
    restoreRead?.abort();
    restoreRead = null;
  }
  function bind(next: string | null) {
    if (world === next) return false;
    invalidate();
    world = next;
    // The workspace publishes the binding and the reset frame together.
    view = {...view, frame: null};
    return true;
  }
  // Follow the durable parent chain; passive cursor reads leave the player's scrollback untouched.
  async function restore(tip: string | null, checkpoint: number, knownAssistantId?: string) {
    if (!world || !view.enabled || checkpoint !== revision) return;
    restoreRead?.abort();
    if (tip && verifiedTip === tip) return;
    const read = new AbortController();
    restoreRead = read;
    let startingTip = tip;
    function finish(frame: Frame | null) {
      verifiedTip = startingTip;
      update({frame});
    }
    const current = history.getSnapshot();
    const entries = new Map<string, Entry>();
    const index = (runs: StoredRun[]) => {
      for (const run of runs) for (const entry of run.entries) entries.set(entry.id, entry);
    };
    index(current.runs);
    let cursor = current.hasMore ? current.nextCursor : null;
    const visited = new Set<string>(), cursors = new Set<string>();
    let refreshed = false;
    try {
      while (tip && !read.signal.aborted) {
        if (visited.has(tip)) return;
        if (verifiedTip === tip) { verifiedTip = startingTip; return; }
        const entry = entries.get(tip);
        if (!entry) {
          // A terminal event can arrive before its committed assistant appears in the local page.
          if (tip === knownAssistantId && !deleted.has(tip)) {
            knownAssistantId = undefined;
            const data = await request<{sessionId: string; messageId: string; result: unknown}>(
              'v1/sessions/' + encodeURIComponent(sessionId) + '/entries/' + encodeURIComponent(tip) + '/character-sprites', {signal: read.signal});
            if (read.signal.aborted || data.sessionId !== sessionId || data.messageId !== tip) return;
            const items = appliedItems(data.result);
            if (items) { finish({messageId: tip, items}); return; }
          }
          // Deletion during paging can break the captured chain. Retry once from a fresh tip and page.
          const reloadHead = !refreshed && (!visited.size || !cursor || cursors.has(cursor));
          if (reloadHead) {
            refreshed = true;
            tip = await readTip(read.signal);
            if (read.signal.aborted) return;
            startingTip = tip;
            if (!tip) break;
            entries.clear();
            visited.clear();
            cursors.clear();
          } else {
            if (!cursor || cursors.has(cursor)) return;
            cursors.add(cursor);
          }
          const page = await history.query({limit: 5, cursor: reloadHead ? undefined : cursor ?? undefined}, read.signal);
          index(page.items);
          cursor = page.hasMore ? page.nextCursor : null;
          continue;
        }
        visited.add(entry.id);
        entries.delete(entry.id);
        if (entry.role === 'assistant' && entry.type === 'message' && !deleted.has(entry.id)) {
          const output = entry.extData.output as {characterSprite?: unknown} | undefined;
          const items = appliedItems(output?.characterSprite);
          if (items) { finish({messageId: entry.id, items}); return; }
        }
        tip = entry.parentId;
      }
      if (!read.signal.aborted) finish(null);
    } catch { /* A failed read is not an explicit empty frame. */ }
    finally { if (restoreRead === read) restoreRead = null; }
  }
  return {
    bind, restore, checkpoint: () => revision, getSnapshot: () => view,
    invalidateAssets() {
      if (!view.frame) return;
      const items = view.frame.items.map(({position, characterId, spriteId}) => ({position, characterId, spriteId}));
      update({frame: {...view.frame, items}});
    },
    setEnabled(value: boolean) {
      if (view.enabled === value) return;
      invalidate();
      try { localStorage.setItem(preference, String(value)); } catch { /* Memory still holds the selection. */ }
      update({enabled: value});
    },
    accept(data: CharacterSpriteChangedEvent['data']) {
      if (!world || data.sessionId !== sessionId || deleted.has(data.messageId)) return;
      invalidate();
      verifiedTip = data.messageId;
      update({frame: {messageId: data.messageId, items: data.items}});
    },
    remove(ids: string[], tip: string | null) {
      const fresh = ids.filter(id => !deleted.has(id));
      if (!fresh.length) return;
      for (const id of fresh) deleted.add(id);
      if (!restoreRead && view.frame && !deleted.has(view.frame.messageId)) {
        verifiedTip = view.frame.messageId;
        return;
      }
      invalidate();
      if (view.frame && deleted.has(view.frame.messageId)) update({frame: null});
      void restore(tip, revision);
    },
    resetHistory() {
      invalidate();
      if (!view.enabled && view.frame) update({frame: null});
    },
    dispose() { invalidate(); world = null; deleted.clear(); },
  };
}
