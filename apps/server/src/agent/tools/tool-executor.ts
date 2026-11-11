import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { ErrorCodes, normalizeError } from '../../common/error-codes.js';
import type { Json } from '../../domain/state/state.js';
import { setState } from './state-tool.js';

/** Tool routing is separate from the model loop; state validation stays in the state domain. */
export class ToolExecutor {
  /** Apply valid updates in order and report invalid items without exposing their values in logs. */
  execute(
    call: ToolCall,
    workspace: Record<string, Json>,
    modules: Record<string, any>,
    active: Set<string>,
  ): ToolResultMessage {
    let result: { ok: boolean; code?: string; updated?: number; skipped?: Array<{ index: number; code: string }> };
    try {
      const args = call.arguments as Record<string, unknown> | undefined;
      if (call.name !== 'update_state' || call.argumentsError || !Array.isArray(args?.updates) || args.updates.length > 100)
        throw new Error(ErrorCodes.INVALID_TOOL_CALL);
      let updated = 0;
      const skipped: Array<{ index: number; code: string }> = [];
      for (const [index, raw] of args.updates.entries()) {
        try {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(ErrorCodes.INVALID_TOOL_CALL);
          const update = raw as Record<string, unknown>;
          if (typeof update.path !== 'string' || !Object.hasOwn(update, 'value')) throw new Error(ErrorCodes.INVALID_TOOL_CALL);
          setState(workspace, modules, active, update.path, update.value);
          updated++;
        } catch (error) {
          const code = normalizeError(error, ErrorCodes.INVALID_STATE_UPDATE).errorCode;
          skipped.push({ index, code });
          console.warn('SR_STATE_UPDATE_SKIPPED', { toolCallId: call.id, index, code });
        }
      }
      result = skipped.length ? { ok: false, code: skipped[0]!.code, updated, skipped } : { ok: true, updated };
    } catch (error) {
      result = { ok: false, code: normalizeError(error, ErrorCodes.INVALID_STATE_UPDATE).errorCode };
    }
    return {
      role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: !result.ok, timestamp: Date.now(),
    };
  }
}
