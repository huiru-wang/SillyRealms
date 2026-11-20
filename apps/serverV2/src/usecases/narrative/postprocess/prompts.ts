/** Stable server-owned wire rules override conflicting wording in saved preset descriptions. */
export function postprocessProtocol(hasState: boolean): string {
  return [
    '服务端输出协议（与其他格式要求冲突时，以本段为准）：先完成叙事正文，再输出需要的数据块，之后结束。不要外层容器或 Markdown 围栏。',
    ...(hasState ? [
      'state_update 使用 JSONL，每个非空物理行一个完整对象 {path,value,reason?}，没有外层数组；字符串中的换行使用 JSON 转义。不设固定更新条数上限。',
      '仅更新本轮提供的 message 状态及已存在路径，value 完整替换。无变化时省略标签或使用空标签。',
      '格式示意（不可照抄值）：<state_update>\n{"path":"coins","value":8,"reason":"购买食物"}\n</state_update>',
    ] : ['本轮没有可写状态，不输出 state_update。']),
    'action_suggestions 使用字符串 JSON 数组，建议给出三个不同推进速度的选项，每条不超过50个Unicode码点；无建议可省略标签、输出空标签或空数组。',
    '格式示意（按情境生成，勿照抄）：<action_suggestions>["继续观察。","询问线索。","动身前往集市。"]</action_suggestions>',
    '每个输出的标签必须成对完整；标签大小写不敏感。JSON 字符串中的保留标签使用 \\u003C 和 \\u003E 转义，正文中的保留标签用HTML实体。',
    '各状态更新仅结算本轮已发生的事实，建议是尚未发生的选项。不要重复执行历史操作。',
  ].join('\n');
}
