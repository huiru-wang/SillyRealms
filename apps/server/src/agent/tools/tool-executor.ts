import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../../common/error-codes.js';
import type { Json } from '../../domain/state/state.js';
import { setState } from './state-tool.js';

/** Tool routing is separate from the model loop; state validation stays in the state domain. */
export class ToolExecutor {
  /** Apply a review as one in-memory transaction; an invalid change must not partially update state. */
  executeReview(
    call: ToolCall, workspace: Record<string, Json>, modules: Record<string, any>, active: Set<string>,
  ): ToolResultMessage {
    let result: { ok: boolean; code?: string; updated?: number };
    try {
      const args = call.arguments as Record<string, unknown>;
      if (call.name !== 'review_state' || call.argumentsError || !Array.isArray(args?.updates) || args.updates.length > 100) {
        throw new Error(ErrorCodes.INVALID_TOOL_CALL);
      }
      const candidate = structuredClone(workspace);
      for (const raw of args.updates) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(ErrorCodes.INVALID_TOOL_CALL);
        const update = raw as Record<string, unknown>;
        if (typeof update.path !== 'string' || !Object.hasOwn(update, 'value')) throw new Error(ErrorCodes.INVALID_TOOL_CALL);
        setState(candidate, modules, active, update.path, update.value);
      }
      for (const [key, value] of Object.entries(candidate)) workspace[key] = value;
      result = { ok: true, updated: args.updates.length };
    } catch {
      result = { ok: false, code: ErrorCodes.INVALID_STATE_UPDATE };
    }
    return {
      role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: !result.ok, timestamp: Date.now(),
    };
  }

  execute(
    call: ToolCall,
    workspace: Record<string, Json>,
    modules: Record<string, any>,
    active: Set<string>,
  ): ToolResultMessage {
    let result: { ok: boolean; code?: string };
    try {
      if (call.name !== 'update_state' || call.argumentsError ||
        !(typeof call.arguments.path === 'string' || Array.isArray(call.arguments.path))) {
        throw new Error(ErrorCodes.INVALID_TOOL_CALL);
      }
      setState(workspace, modules, active, call.arguments.path as string | string[], call.arguments.value);
      result = { ok: true };
    } catch {
      result = { ok: false, code: ErrorCodes.INVALID_STATE_UPDATE };
    }
    return {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: !result.ok,
      timestamp: Date.now(),
    };
  }
}
