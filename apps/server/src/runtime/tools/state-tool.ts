export { applyRuntimeStateUpdate as setState } from '../../domain/state/runtime-update.js';

/** Submit verified state changes; empty updates are valid. */
export const stateTool = {
  name: 'update_state',
  description: 'Submit verified updates to active message state. Call at least once per turn, with an empty updates array if nothing changed. Use complete replacement values.',
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
    '1. 识别故事中实际发生、已经确定的事件；玩家的写作指令、猜测和未成功的尝试都不是状态变化依据。',
    '2. 将本轮事件与下方【可更新状态】的描述、规则和当前值逐项比对；只修改明确发生变化且已经激活的 message 状态，禁止修改 global/session 或未激活字段。',
    '3. 使用 update_state({"updates":[{"path":"状态名.字段","value":"完整新值"}]}) 提交变化；path 是英文句点分隔的路径，value 是覆盖目标的完整值，不是差值或补丁。',
    '4. 本轮至少调用一次 update_state；没有状态变化时使用 {"updates":[]}，不要虚构变化或重复提交原值。根据工具结果继续处理当前任务。',
    '更新 JSON 内部路径时父对象须存在；需要删除字段或修改数组时，提交整个所属对象或数组的更新后值。',
  ].join('\n');
}
