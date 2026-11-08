# SR Roleplay Composer：Block 编辑与键盘交互 V3

> 状态：已实施，待用户手动交互验收
> 本方案取代 V2 Inline Composer 方案。不得继续使用 Inline TextNode 或零宽占位符。

## 1. 目标

恢复稳定的块级输入模型：普通旁白使用普通 ParagraphNode；内心、话语、叙事指令使用独立的单行语义 Block。输入时可清楚进入和退出特殊块，不依赖行内颜色或占位光标。

## 2. 键盘协议

- Enter：普通旁白换行。
- Shift+Enter：普通旁白换行。
- Enter / Shift+Enter 位于特殊类型块：结束当前块，在下一行创建或复用普通旁白块，并将光标移出特殊块。
- Cmd+Enter：发送。为跨平台兼容，同时支持 Ctrl+Enter。
- 输入法 composition 期间不拦截 Enter，避免破坏中文输入提交。

## 3. 类型块

- `RoleplayBlockNode` 继承 Lexical `ParagraphNode`，kind 为 thought / speech / instruction。
- 旁白继续使用普通 `ParagraphNode`。
- 特殊块只允许单行；粘贴多行文本时将换行替换为空格。
- 特殊块具有独立背景、左侧标识和类型标签。
- 叙事指令保持唯一；点击按钮时创建或移动到当时内容尾部。用户按 Enter 退出后可以继续输入旁白，序列化保留编辑器顺序；服务端仍独立提取指令，不将其作为叙事内容。

## 4. 插入规则

- 当前空旁白行：直接替换为空的类型块，不增加前置或后置空行。
- 当前非空旁白行：在光标处拆分文本，插入类型块，保留光标前后的文本。
- 光标位于已有类型块：在其后插入；若紧邻一个空旁白行，则用新类型块替换该空行。
- 插入类型块本身不自动创建后置空行。
- 在类型块中按 Enter 时才创建或复用下一行旁白。

## 5. 发送与空行

- 普通旁白的空段落参与序列化，确保中间空行可以往返恢复。
- 发送前只移除序列化文本尾部连续空行，不删除中间空行。
- 空的特殊类型块不发送。
- Cmd+Enter 使用编辑器当前状态生成待发送文本，避免 React state 尚未同步造成漏字。
- Host 在 POST 成功后立即清空；保留 draft revision，防止清空发送期间的新输入。

## 6. 协议兼容

- 保持 SR-RP v1 标签和语义：thought 使用 `>`，speech 使用引号包裹，instruction 使用 `<sr_instruction>`。
- 序列化按编辑器顺序输出。指令块可以在用户按 Enter 后被普通旁白块跟随；服务端 parser 仍按标签独立提取 instructionText，`narrativeText` 会移除指令范围。
- Parser 为 Composer 保留中间空旁白块；普通解析结果仍忽略空块。

## 7. 验收

- 空行插入特殊块无多余空行。
- 在非空行中间插入，前后文本不丢失。
- 特殊块 Enter 后退出到旁白；特殊块内部不能产生换行。
- 普通 Enter 不发送，Cmd+Enter 发送。
- 指令唯一，按钮点击后位于当前内容尾部。
- 中间空行保留，尾部连续空行发送前清理。
- SR-RP v1 parser/serializer、Web typecheck、build 通过。
- 本次不运行浏览器回归，由用户手动验收。
