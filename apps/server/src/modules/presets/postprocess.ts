import type { NarrativePresetConfig } from './schema.js';

/** Capability defaults are owned by presets; request compilation resolves their variables. */
export const defaultPostprocessPrompts = {
  worldState: [
    '根据本轮最终叙事正文，生成 state_update 数据块。',
    '',
    '当前可更新的 message 状态及规则：',
    '',
    '{{state.entries}}',
    '',
    '更新要求：',
    '',
    '1. 以本轮提供的 value 为旧值基准，只更新正文已确认、或根据字段规则能够确定推导出的变化。证据不足或没有变化时保持原值。不重复结算历史，不提前结算计划、承诺或行动建议的结果。',
    '2. 只更新本轮列出的状态根，遵守 type、description、rules 及提供的 min/max。path 从根名开始，使用英文句点连接；根项、中间对象和目标位置均须已存在。不额外添加 scope 前缀，不使用数组索引，也不将含 [] 的元素规则作为更新路径。',
    '3. value 是完整新值，不是差额或合并补丁。替换对象或数组时，保留未变化且仍应存在的字段或元素；内容增删须符合本轮事实和规则。null 是值，不表示删除，仅在类型和规则允许时使用。',
    '',
    '输出要求：',
    '',
    '- 输出一个完整的 state_update 数据块，内部使用 JSONL：每个非空物理行一个完整 JSON 对象，不使用外围数组，行之间不加逗号。',
    '- 每项必须包含 path 和 value，可包含字符串 reason，除此之外不允许其他顶层字段。reason 只简短说明本轮事实依据。',
    '- 数字、布尔值和 null 使用实际 JSON 类型；字符串内部换行使用 \\n 转义。不输出代码围栏或额外解释。',
    '',
    '格式示例，路径、值和理由须替换为本轮实际内容：',
    '',
    '<state_update>',
    '{"path":"模块.字段","value":"新值","reason":"本轮已确认的变化依据"}',
    '</state_update>',
    '',
    '没有可确认变化时，输出 <state_update></state_update>，不输出空数组。',
    '',
    '完成状态块后，继续完成统一输出协议中的后续任务。',
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
