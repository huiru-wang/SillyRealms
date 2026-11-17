import {decodeMessageState,validateSnapshot,type Json} from '../../domain/state/state.js';
import {storedError} from '../../domain/world-card.js';
import {readWorld} from '../../repositories/world-repository.js';
import {ErrorCodes} from '../../common/error-codes.js';
import {RuntimeError} from '../shared/errors.js';
import {deepFreeze} from '../config.js';
import type {RunStore} from '../persistence/run-store.js';
import type {SummaryCandidate} from '../types.js';
import type {SourceSnapshot} from './contracts.js';
/** Capture all world/session/history sources synchronously, before any model or credential await. */
export function captureSources(store:RunStore,sessionId:string,expectedTip:string,input:string){
 const session=store.session(sessionId);if(!session)throw new RuntimeError(ErrorCodes.SESSION_NOT_FOUND);
    const worldRow = store.world(String(session.world_id));
    if (!worldRow) throw new RuntimeError(ErrorCodes.WORLD_NOT_FOUND);
    let world: ReturnType<typeof readWorld>['data'];
    try { world = readWorld(worldRow).data; }
    catch (error) { const failure=storedError(error); throw new RuntimeError(failure.code, failure.details); }
    const chain = store.ancestors(sessionId, expectedTip);
    const stateRow = [...chain].reverse().find(row => row.state !== null);
    let messageState: Record<string, Json>;
    try { messageState = decodeMessageState(stateRow?.state ?? '[]'); }
    catch (error) { const failure=storedError(error,'message'); throw new RuntimeError(failure.code, failure.details); }
    const views = { global: JSON.parse(worldRow.state), session: JSON.parse(session.state), message: structuredClone(messageState) };
    try { for (const scope of ['global', 'session', 'message'] as const) validateSnapshot(world.state, scope, views[scope]); }
    catch (error) { const failure=storedError(error,'message'); throw new RuntimeError(failure.code, failure.details); }
    const history=chain.flatMap(row=>store.narrative(row));
    const oldRow = [...chain].reverse().find(row => row.type === 'compaction');
    const oldExt = oldRow ? JSON.parse(oldRow.ext_data).summary : undefined;
    const boundary = oldExt ? chain.findIndex(row => row.id === oldExt.coveredThroughEntryId) : -1;
    const oldText = oldRow ? JSON.parse(oldRow.payload).summary : undefined;
    const historyBoundary = oldExt ? history.findIndex(item => item.id === oldExt.coveredThroughEntryId) : -1;
    // Invalid summary metadata can be ignored because the complete valid source chain is available.
    const oldSummary: SummaryCandidate | undefined = oldExt && boundary >= 0 && boundary < chain.indexOf(oldRow!) &&
      historyBoundary >= 0 && (!history[historyBoundary + 1] || history[historyBoundary + 1]!.role === 'user') &&
      typeof oldText === 'string' && oldText.trim()
      ? { text: oldText, coveredThroughEntryId: oldExt.coveredThroughEntryId } : undefined;
    const playerId = String(session.user_character_id);
    deepFreeze(world); deepFreeze(views); deepFreeze(history);
    const snapshot:SourceSnapshot=deepFreeze({world,views,playerId,input});
 return {snapshot,history,oldSummary,messageState,world};
}
