import { ErrorCodes } from '../../common/error-codes.js';
import { updateAtomicState, type AtomicStateDefinition } from '../../domain/state/atomic-state.js';
import type { Json } from '../../domain/state/state.js';

/** The model and creator both use the same validated overwrite semantics. */
export function setState(workspace:Record<string,Json>, fields:Record<string,AtomicStateDefinition>, active:Set<string>, path:string|string[], value:unknown):void {
  const parts=typeof path==='string'?path.split('.'):path;
  if(!parts.length || parts.some(part=>typeof part!=='string' || !part || part.includes('.')))throw new Error(ErrorCodes.INVALID_STATE_PATH);
  if(!active.has(parts[0]!))throw new Error(ErrorCodes.STATE_ROOT_NOT_ACTIVE);
  updateAtomicState(workspace,fields,parts.join('.'),value);
}

/** One mandatory submission after narrative generation; empty updates is a valid no-change result. */
export const stateTool = {
  name: 'update_state',
  description: 'After the narrative, submit all verified updates to active message state together. Always call once; use updates: [] if unchanged.',
  parameters: {
    type: 'object',
    properties: {
      updates: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Active state name, optionally followed by .nested.field' },
            value: { description: 'Complete replacement value; required for every update' },
          },
          required: ['path', 'value'],
          additionalProperties: false,
        },
      },
    },
    required: ['updates'],
    additionalProperties: false,
  },
};

/** Platform-owned decision guide inserted before the state definitions. */
export function stateToolInstructions(): string {
  return [
    '【状态更新判断】',
    '以下判断仅在内部进行，不要输出判断过程、分析报告或状态 JSON。',
    '1. 先完成本轮故事叙事，再识别本轮实际发生、已经确定的事件；玩家的写作指令、猜测和未成功的尝试都不是状态变化依据。',
    '2. 将本轮事件与下方【可更新状态】的描述、规则和当前值逐项比对；只修改明确发生变化且已经激活的 message 状态，禁止修改 global/session 或未激活字段。',
    '3. 把所有变化合并到同一次 update_state({"updates":[{"path":"状态名.字段","value":"完整新值"}]}) 调用中；path 是英文句点分隔的路径，value 是覆盖目标的完整值，不是差值或补丁。',
    '4. 即使没有任何变化，也必须在叙事后调用 update_state({"updates":[]})；不要为了调用工具而虚构变化，也不要重复提交原值。工具调用后停止本轮，不要再续写叙事。',
    '更新 JSON 内部路径时父对象须存在；需要删除字段或修改数组时，提交整个所属对象或数组的更新后值。',
  ].join('\n');
}
