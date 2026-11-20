import type { NarrativePresetConfig } from './schema.js';

/** Capability defaults are owned by presets; request compilation resolves their variables. */
export const defaultPostprocessPrompts = {
  worldState: [
    '<世界状态>',
    '正文结束后，根据本轮已经发生且可确认的变化更新当前 message 状态；无变化时可输出空 state_update 标签或省略该标签。',
    '当前可更新状态及规则：',
    '{{state.entries}}',
    '只更新本轮激活的状态根及实际存在的路径。value 是完整新值，不是增量或合并；不创建节点、不使用数组索引，null 不表示删除。',
    '不重复结算历史事件，不提前执行计划或行动建议；自然语言 reason 仅说明本次更新理由。',
    'state_update 使用 JSONL：每个非空物理行一个完整的 {"path":"路径","value":"新值","reason":"可选理由"} 对象，不使用外围数组。',
    '字符串中的换行用 JSON 转义；保留标签出现在字符串值中时，对 < 和 > 使用 JSON Unicode 转义。',
    '有更新时输出完整的一对 <state_update> 与 </state_update>，每条更新单独一行。正文中要展示保留标签时使用 HTML 实体。',
    '</世界状态>',
  ].join('\n'),
  actionSuggestions: [
    '<行动建议>',
    '行动建议是提供给玩家选择的下一步行动，不代表已经执行，不改变当前状态。',
    '结合本轮正文结束后的情境，优先生成三个有区别的选择，依次侧重缓慢互动、中速推进、快速推进。',
    '每条建议为非空字符串，简短具体，trim 后不超过 50 个 Unicode 码点；只描述可以尝试的行动，不预先保证结果，不附速度标签或说明。',
    '正文结束后输出完整的一对 <action_suggestions> 与 </action_suggestions>，内容为字符串 JSON 数组，不使用外围容器或 Markdown 围栏。',
    '没有合适建议时可以输出空标签、空数组或省略标签。不要用空字符串占位，不为凑足数量编造建议。',
    '保留标签出现在 JSON 字符串值中时，对 < 和 > 使用 JSON Unicode 转义；正文中要展示保留标签时使用 HTML 实体。',
    '</行动建议>',
  ].join('\n'),
};

/** Default capabilities ignore legacy enabled flags without mutating the saved preset. */
export function resolvePostprocessPrompts(config: NarrativePresetConfig): { worldState: string; actionSuggestions: string } {
  const resolve = (id: keyof typeof defaultPostprocessPrompts) => {
    const prompt = config.nodes.find(node => node.id === id)?.prompt;
    return prompt?.trim() ? prompt : defaultPostprocessPrompts[id];
  };
  return { worldState: resolve('worldState'), actionSuggestions: resolve('actionSuggestions') };
}
