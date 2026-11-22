import type { NarrativePresetConfig } from './schema.js';

/** Capability defaults are owned by presets; request compilation resolves their variables. */
export const defaultPostprocessPrompts = {
  worldState: [
    '结合以下状态续写本轮剧情。人物所知以其亲历、被告知或已确认的事实为准。',
    '',
    '【全局状态｜只读】',
    '{{state.global}}',
    '',
    '【会话状态｜只读】',
    '{{state.session}}',
    '',
    '【消息状态｜可更新】',
    '{{state.message}}',
    '',
    '写作时，遵循全局设定，沿用本局已确定的玩家人设和选择。人物当前的位置、物品、关系与事件进展，以消息状态中的当前值为起点。玩家的偏好或选择可以影响叙事走向，尚未发生的事仍须通过剧情发生。',
    '',
    '完成正文后，只检查上方列出的可更新消息状态。依据本轮已发生的事实和对应字段规则，提交有根据的变化。每个路径只提交一次最终值，保留同一对象中未变化的字段。全局状态和会话状态仅供参考，不写入 state_update。',
    '',
    '本轮没有可更新的消息状态时，省略 state_update；有可更新状态但本轮没有变化时，按统一输出协议省略该块或输出空块。',
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
