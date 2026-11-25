import type {CharacterSpriteChangedEvent, CharacterSpriteItem, Entry, StoredRun} from '../../../../../packages/sr-sdk/src/stage-contract.ts';
import type {HttpRequest} from '../../transport/http.ts';
import type {HistoryController} from '../history/index.ts';
import {appliedItems} from './items.ts';

type CatalogItem = {characterId: string; spriteId: string; characterName: string; asset: string};
type Frame = {messageId: string; items: CharacterSpriteItem[]};
export type SpriteDisplay = {enabled: boolean; frame: Frame | null; catalog: readonly CatalogItem[]};
type Options = {
  sessionId: string; request: HttpRequest; history: HistoryController;
  readTip: (signal: AbortSignal) => Promise<string | null>; changed: () => void;
};

export function createSpriteController({sessionId, request, history, readTip, changed}: Options) {
  const preference = 'sr:session:' + sessionId + ':show-character-sprites';
  let enabled = true;
  try { enabled = localStorage.getItem(preference) !== 'false'; } catch { /* Optional browser preference. */ }
  let view: SpriteDisplay = {enabled, frame: null, catalog: []};
  let world: string | null = null, revision = 0;
  let verifiedTip: string | null = null;
  let catalogRead: AbortController | null = null, restoreRead: AbortController | null = null;
  let catalogLoaded = false;
  const deleted = new Set<string>();
  const update = (patch: Partial<SpriteDisplay>) => { view = {...view, ...patch}; changed(); };
  function invalidate() {
    revision++;
    verifiedTip = null;
    restoreRead?.abort();
    restoreRead = null;
  }
  async function loadCatalog() {
    if (!world || !view.enabled || catalogLoaded || catalogRead) return;
    const read = new AbortController();
    catalogRead = read;
    try {
      const data = await request<{worldId: string; items: CatalogItem[]}>('v1/worlds/' + encodeURIComponent(world) + '/character-sprites', {signal: read.signal});
      if (!read.signal.aborted && world === data.worldId && Array.isArray(data.items)) {
        catalogLoaded = true;
        update({catalog: data.items});
      }
    } catch { /* Keep narration available. Retry on the next sync or reveal. */ }
    finally { if (catalogRead === read) catalogRead = null; }
  }
  function bind(next: string | null) {
    if (world === next) return false;
    invalidate();
    catalogRead?.abort();
    catalogRead = null;
    catalogLoaded = false;
    world = next;
    // The workspace publishes the binding and the reset frame together.
    view = {...view, catalog: [], frame: null};
    void loadCatalog();
    return true;
  }
  // Follow the durable parent chain; passive cursor reads leave the player's scrollback untouched.
  async function restore(tip: string | null, checkpoint: number, knownAssistantId?: string) {
    if (!world || !view.enabled || checkpoint !== revision) return;
    void loadCatalog();
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
    setEnabled(value: boolean) {
      if (view.enabled === value) return;
      invalidate();
      try { localStorage.setItem(preference, String(value)); } catch { /* Memory still holds the selection. */ }
      update({enabled: value});
      if (value) void loadCatalog();
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
    dispose() { invalidate(); catalogRead?.abort(); world = null; deleted.clear(); },
  };
}
