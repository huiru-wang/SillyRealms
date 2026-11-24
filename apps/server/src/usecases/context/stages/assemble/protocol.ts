import type { ContextCapabilities } from '../../capabilities.js';

/** Server wire rules are only included for the capabilities constructed in this request. */
export function postprocessProtocol(capabilities: ContextCapabilities, hasWritableState: boolean): string {
  return [
    '服务端输出协议（与其他格式要求冲突时，以本段为准）：先完成叙事正文，再输出本轮已构建能力的数据块，之后结束。不要外层容器或 Markdown 围栏。',
    ...(capabilities.worldState && hasWritableState ? [
      'state_update 使用 JSONL，每个非空物理行一个完整对象 {path,value,reason?}，没有外层数组；字符串中的换行使用 JSON 转义。不设固定更新条数上限。',
      '仅更新本轮提供的 message 状态及已存在路径，value 完整替换。无变化时省略标签或使用空标签。',
      '格式示意（不可照抄值）：<state_update>\n{"path":"coins","value":8,"reason":"购买食物"}\n</state_update>',
    ] : []),
    ...(capabilities.worldState && !hasWritableState ? ['本轮没有可写状态，不输出 state_update。'] : []),
    ...(capabilities.actionSuggestions ? [
      'action_suggestions 使用字符串 JSON 数组，建议给出三个不同推进速度的选项，每条不超过50个Unicode码点；无建议可省略标签、输出空标签或空数组。',
      '格式示意（按情境生成，勿照抄）：<action_suggestions>["继续观察。","询问线索。","动身前往集市。"]</action_suggestions>',
    ] : []),
    ...(capabilities.characterSprite ? [
      'character_sprite 使用扁平 JSONL，每个非空行是只有 position、characterId、spriteId 三个必填字段的对象，无外层数组和嵌套对象。',
      'characterId 与 spriteId 必须来自本轮立绘目录。同一完整快照中 characterId 分别唯一，position 也分别唯一；一个角色不能出现多次，一个位置不能给多个角色。',
      'position 只允许 left、center、right、top、topleft、topright、truecenter；可以展示超过两个角色，各占不同位置，最多七个有效条目。位置表达故事安排，前端如何展示由组件决定。',
      '每轮必须给出最新完整快照，即使没有变化也全部输出；不输出增量、操作指令、图片地址或 CSS。当前场景没有立绘时输出 <character_sprite></character_sprite>，不以 [] 代替空标签。',
      '格式示意（按本轮目录与情境生成，勿照抄）：<character_sprite>\n{"position":"left","characterId":"alice","spriteId":"default"}\n{"position":"center","characterId":"bob","spriteId":"default"}\n{"position":"right","characterId":"carol","spriteId":"default"}\n</character_sprite>',
    ] : []),
    '每个输出的标签必须成对完整；标签大小写不敏感。JSON 字符串中的保留标签使用 \\u003C 和 \\u003E 转义，正文中的保留标签用 HTML 实体。',
    '数据块依据本轮已发生的事实和各自指令生成，各能力独立处理，不重复执行历史操作。',
  ].join('\n');
}
