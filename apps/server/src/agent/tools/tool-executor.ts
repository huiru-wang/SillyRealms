import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { ErrorCodes, normalizeError } from '../../common/error-codes.js';
import type { Json } from '../../domain/state/state.js';
import { setState } from './state-tool.js';

/** Tool routing is separate from the model loop; state validation stays in the state domain. */
export class ToolExecutor {
  /** Apply an entire update_state batch atomically: one invalid item rejects every change. */
  execute(
    call: ToolCall,
    workspace: Record<string, Json>,
    modules: Record<string, any>,
    active: Set<string>,
  ): ToolResultMessage {
    let result: { ok: boolean; code?: string; updated?: number };
    try {
      const args = call.arguments as Record<string, unknown> | undefined;
      if (call.name !== 'update_state' || call.argumentsError || !Array.isArray(args?.updates) || args.updates.length > 100)
        throw new Error(ErrorCodes.INVALID_TOOL_CALL);
      const candidate = structuredClone(workspace);
      const paths = new Set<string>();
      for (const raw of args.updates) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(ErrorCodes.INVALID_TOOL_CALL);
        const update = raw as Record<string, unknown>;
        if (typeof update.path !== 'string' || !Object.hasOwn(update, 'value') || paths.has(update.path))
          throw new Error(ErrorCodes.INVALID_TOOL_CALL);
        paths.add(update.path);
        setState(candidate, modules, active, update.path, update.value);
      }
      for (const [key, value] of Object.entries(candidate)) workspace[key] = value;
      result = { ok: true, updated: args.updates.length };
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
