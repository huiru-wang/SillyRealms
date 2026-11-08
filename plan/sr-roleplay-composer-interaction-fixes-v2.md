> 状态：已被 `sr-roleplay-composer-block-interaction-v3.md` 取代。V2 的 Inline 设计不再执行。

# SR 角色扮演输入 Composer：Inline 编辑、Block 序列化与发送交互修复方案 V2

> 状态：已实施，待用户手动交互验收
> 更新日期：2026-11-09
> 关联方案：plan/sr-roleplay-input-system-main-v1.md
> 本方案替代此前 V1 中「动作、内心、话语均采用独立块级编辑节点」的 Composer 修复设计。发送时机与草稿保护目标继续保留。
> 本方案依据 2026-11-09 当前工作区源码制定。创建和更新 Plan 不代表代码已经修改或验收。

## 1. 目标与已确认决策

修复并统一解决以下输入体验问题：

1. 点击「内心 / 话语」后产生多余空行，或必须通过额外段落才能继续输入。
2. 空编辑器点击「内心 / 话语」也会产生无意义空段落。
3. 点击发送后，已提交内容一直保留到模型生成完成才清空。
4. 发送期间继续输入的新内容，不能被上一条请求的清空操作覆盖。
5. 叙事指令必须始终追加在输入内容尾部，不与叙事正文混排。

已确认的产品决策：

- **输入框使用 Inline 编辑模型**：动作、内心、话语在同一段叙事流中连续编辑。
- **发送、User Entry、模型 User Prompt 使用 Block 格式**：发送前由 Serializer 将 Inline 编辑结构转换为 SR-RP v1 现有块级文本协议。
- **SR.WorldStory 继续按 Block 语义渲染**：不把输入框的 Inline 视觉结构带入已发送消息。
- **叙事指令保留独立尾部区域**：不作为 Inline 节点，不允许插入正文中间；重复点击定位到已有区域。
- **不改变 SR-RP v1 的服务端文本协议**，不改变数据库、Run API、Agent Prompt 或消息历史结构。
- **服务端成功接受 POST 并返回 runId 后立即清空**；请求失败保留草稿，发送期间产生的新编辑必须保留。

## 2. 当前代码基线与根因

### 2.1 当前 Composer 仍是块级模型

当前文件：

- apps/web/src/features/sessions/composer/RoleplayComposer.tsx
- apps/web/src/features/sessions/composer/roleplay-nodes.ts
- apps/web/src/features/sessions/composer/roleplay-composer.css

现状：

- RoleplayNode 继承 ParagraphNode。
- thought、speech、instruction 都是独立顶层段落。
- 快捷按钮调用 selection.insertParagraph()，再插入新的 RoleplayNode。
- 插入逻辑没有可靠处理拆分产生的空段落。
- RoleplayNode.insertNewAfter() 返回普通 ParagraphNode，特殊节点拆分时可能丢失原 kind。
- 当前 CSS 通过 block padding、左边框和 ::before 标签强化独立块外观。

这套节点模型天然把 thought / speech 作为独立段落，继续修补空段落只能缓解表象，不能提供用户期望的连续行内编辑体验。

### 2.2 当前序列化与解析能力

文件：packages/sr-roleplay/src/index.ts

现有共享协议已经提供：

- RoleplayKind：action / thought / speech / instruction。
- RoleplayBlock：kind + text。
- serializeRoleplay(blocks)：将动作、内心、话语序列化为 SR-RP v1 Block 文本，并把 instruction 统一放到最后。
- parseRoleplay(text, role)：将 Block 文本解析为 blocks、instructionText、narrativeText 和 ranges。
- thought 使用 Markdown 引用块表示，speech 使用中文引号表示，instruction 使用 sr_instruction 标签表示。
- 解析器已经识别 Markdown / HTML / fenced code 的保护范围，并提供 inline speech ranges。

现有协议不需要改变。需要补足的是 Composer 专用的解析投影：把 Block 消息恢复为 Inline 编辑节点，同时正确识别已有解析器发现的 inline speech ranges，不能在 Composer 内另写一套正则解析器。

### 2.3 当前 Host 发送清空逻辑

文件：apps/web/src/host.tsx

当前实现通过 submittedDraft、terminalOutcomes 和 run.completed 事件延迟清空草稿。

send(text) 已经在 POST /runs 成功并拿到 runId 后 resolve。因此可以直接以该返回点作为清空边界，不需要修改 Server。

## 3. 最终编辑器内容模型

### 3.1 节点结构

建议在 Lexical 中采用以下结构：

| 语义 | Lexical 节点 | 编辑时表现 |
|---|---|---|
| 动作 | 普通 TextNode | 默认文本 |
| 内心 | RoleplayInlineNode（kind=thought），继承 TextNode | Inline 紫色语义样式 |
| 话语 | RoleplayInlineNode（kind=speech），继承 TextNode | Inline 黄色语义样式 |
| 叙事指令 | RoleplayInstructionNode，独立块级节点 | 编辑器尾部的独立区域 |
| 段落 / 换行 | Lexical ParagraphNode / LineBreakNode | 保留用户明确输入的换行 |

重要约束：

- RoleplayInlineNode 必须是可编辑 Inline TextNode，通过 kind 区分 thought / speech，不再继承 ParagraphNode。
- 不得使用会导致节点不可编辑或光标无法进入的 token / segmented 模式，除非用户手动回归证明其行为符合全部要求。
- 自定义 TextNode 的 clone、importJSON、exportJSON、createDOM、updateDOM、splitText / insertNewAfter 等行为必须保留语义 kind。
- Lexical 对相邻 TextNode 的合并、拆分和格式继承行为需要按当前锁定版本 0.53 实测，不能只凭类型定义推断。
- RoleplayInstructionNode 保留独立块级编辑能力，且一个编辑器中最多存在一个尾部指令区域。
- 不创建仅用于填充空行的无意义段落；编辑器仍需保留可输入的正文根节点。

### 3.2 Inline 样式

- RoleplayInlineNode（thought）：低饱和紫色文字或浅紫色行内底色，圆角与行高不破坏正文阅读。
- RoleplayInlineNode（speech）：暖黄色文字或浅黄色行内底色。
- 不再使用当前块级样式中的大面积 padding、左侧竖线和独占一行的 ::before 标签。
- Speech 的中文引号可用装饰性视觉标记展示；引号是否属于节点实际文本必须与 Serializer 约定一致，不能出现重复加引号。
- Inline 节点跨行时使用适当的 box-decoration-break，避免多行选区出现不连续的背景。
- 明暗主题都必须有足够对比度。

### 3.3 插入与继续输入行为

**内心 / 话语按钮：**

1. 有有效光标时，在当前光标处插入对应 Inline 节点，不创建新段落。
2. 有选区时，用新 Inline 节点替换选区，选区外内容完整保留。
3. 编辑器为空时，直接在当前空正文位置插入 Inline 节点，不留下额外空 action 段落。
4. 插入后光标进入新节点，用户立即输入的文字属于该类型。
5. 插入点之后已有的原始文本继续保持原有语义类型。
6. 如果插入点位于正文末尾，确保特殊节点后存在可进入的普通 action 文本位置，但不额外展示空白行。
7. 用户可通过点击特殊节点之后的位置或按方向键越过节点，继续输入普通 action；若没有后继 action TextNode，则在需要时创建空 TextNode。
8. 在特殊节点中间编辑造成拆分时，拆分后的两段必须保留原 kind。
9. 方向键、鼠标定位和选区跨越节点时保持 Lexical 原生文本编辑体验。只有用户手动回归发现必要时，才增加局部键盘命令，不自行重写光标导航。

默认键盘行为：插入后连续输入沿用当前特殊类型；光标越过该节点进入普通文本后，后续输入恢复 action。不得要求用户通过增加空行才能退出特殊类型。

**叙事指令按钮：**

1. 首次点击时，在正文末尾追加唯一的 RoleplayInstructionNode。
2. 光标进入指令区域，用户输入内容。
3. 再次点击时，直接定位到已有指令区域，不重复创建空区域。
4. 指令区域始终位于正文之后；正文编辑和光标移动不能把它插入中间。
5. 指令为空时序列化忽略该区域；删除全部指令内容后可保留空区域供继续输入，也可以在明确删除操作后移除，但不能残留多个空指令节点。
6. 从外部 Block 文本恢复时，若存在多个 instruction 块，按原顺序合并到同一个尾部编辑区域，中间以换行分隔；再次发送时可序列化为一个合法的 sr_instruction 区域。

## 4. Inline 编辑与 Block 消息的双向转换

### 4.1 唯一持久化与发送格式

编辑器内部节点树只用于编辑体验，不作为持久化格式。

统一数据流：

    Inline Lexical Editor
            |
            | serialize
            v
    SR-RP v1 Block Text
            |
            +--> Host draft string
            +--> POST /runs text
            +--> persisted User Entry
            +--> model User Prompt
            +--> SR.WorldStory MessageContent

所有下游消费者继续接收当前 SR-RP v1 Block 文本，不感知 Inline 节点。

### 4.2 Inline 到 Block 的 Serializer

Composer 在每次编辑器内容变化时遍历 Lexical 节点，生成有序 RoleplayBlock[]：

- 普通 TextNode 归入 action。
- RoleplayInlineNode(kind=thought) 归入 thought。
- RoleplayInlineNode(kind=speech) 归入 speech。
- InstructionNode 归入 instruction。
- LineBreakNode / 段落边界按当前文本协议保留为对应文本中的换行或块边界。
- 相邻且语义相同的 TextNode 合并，避免无意义碎片。
- 相邻不同 kind 的节点保持顺序，不能因为 DOM 展示或节点合并丢失类型。
- instruction 无论编辑器内部状态如何，都由现有 serializeRoleplay 规则放在最终文本尾部。
- 空语义节点不生成消息内容，但其编辑器结构变化仍然属于一次有效编辑，必须触发 Host draft revision。
- 发送时仍调用 packages/sr-roleplay 的 serializeRoleplay，不在 Host 或 Server 复制序列化逻辑。

输出示例：

输入框视觉上连续显示：

    他走进大厅， [紫色内心：这里似乎有人来过。] 他抬起头， [黄色话语：有人吗？]

实际提交的 User 文本：

    他走进大厅，

    > 这里似乎有人来过。

    他抬起头，

    “有人吗？”

    <sr_instruction>
    加强环境描写，不替玩家决定行动。
    </sr_instruction>

发送后用户消息与模型上下文继续使用上述 Block 文本。

### 4.3 Block 到 Inline 的 Parser Projection

修改范围：packages/sr-roleplay/src/index.ts，或在同一包中新增 Composer 专用 projection 模块。

要求：

- 复用 parseRoleplay 的解析结果、ranges 和 HTML / Markdown / code 保护判断。
- 不在 RoleplayComposer 内重新实现引号、Markdown 引用块或 sr_instruction 的正则解析。
- 将 thought / speech 恢复为 Inline 语义节点。
- 将 instruction 提取到唯一尾部 RoleplayInstructionNode。
- 普通 action 恢复为普通 TextNode。
- 对 action 文本中已经识别的 inline speech ranges，也必须恢复为 RoleplayInlineNode(kind=speech)，不能因为它未独立成块就丢失语义。
- 解析出的语义片段按原始 UTF-16 offset 排序，保证 emoji、中文和混合文本不发生位置偏移。
- 保留各片段自身文本、换行和顺序；协议生成的块间空行属于 Block 展示分隔，在 Composer 中恢复为连续 Inline 叙事流，不额外显示空白段落。
- 相邻不同 kind 的片段直接以内联节点相邻排列，不能把协议分隔用的空行重新显示成独立块；片段原有的前后空格仍须保留。
- 相邻且同 kind、但在原文中属于独立段落的片段，使用编辑器段落边界或等价换行保留原有段落关系，不能无条件拼接丢失换行。
- 用户明确输入的单块内部换行必须保留。
- 如果原文含有 Markdown / HTML / fenced code 中的字面引号、引用标记或 sr_instruction 标签，必须继续按现有 parser 的保护规则作为普通内容，不能误转成特殊节点。
- 多个 instruction 按顺序聚合到尾部区域。

建议新增纯函数，例如 parseRoleplayForComposer(text, role)，返回有序的 inline segments 和 instruction 内容。该函数只增加编辑器投影能力，不改变现有 parseRoleplay 返回值语义和服务端调用行为。

### 4.4 标点、空格与内容保真

- Serializer 必须保持各节点内原始字符顺序，不擅自 trim 普通文本。
- 用户在 RoleplayInlineNode(kind=speech) 内输入的标点属于话语内容，最终放入中文引号内部。
- 用户在 speech Inline 节点后、普通 action 区域输入的连续标点，如果紧邻且仅包含标点字符，应合并到前一个 speech 内容，避免序列化成孤立的标点 Block。
- 非标点的后续 action 文本不能并入 speech。
- 前置动作文本（例如“他说：”）仍是 action，不能错误并入 speech。
- 需要覆盖中文和英文标点、闭合括号及省略号；具体字符集合在实现中集中定义并测试。
- 对空格、换行、emoji、反斜线、中文引号和保留协议标记执行 round-trip 测试。
- 若某种标点归属存在歧义，优先保持用户实际输入文本顺序，不丢字、不重复，不做激进自动改写。

## 5. 叙事指令尾部区域

- 指令区域在编辑器视觉上与正文有明确但低强调的分隔。
- 只有一个区域，标题为「叙事指令」，可包含多行文本。
- 点击快捷按钮时自动滚动 / 聚焦到该区域，不创建第二个空区域。
- 用户可以在指令区域内编辑、删除、全选和粘贴。
- 指令内容不参与 thought / speech Inline 样式。
- Serializer 把指令内容作为 instruction Block 交给现有 serializeRoleplay，确保最终始终位于文本尾部。
- 用户 prompt 与 User Entry 中仍使用现有 sr_instruction 标签。
- Assistant 消息解析规则、状态审查、世界书激活和 System Main 的权限边界不在本次修改范围内。

## 6. Host 草稿与发送成功后立即清空

修改：apps/web/src/host.tsx

### 6.1 Draft revision

增加 Host 内部 draft revision ref，以及统一的草稿更新入口：

- updateDraft(value)：每次收到有效的 Composer 编辑更新或 iframe set-draft 时递增 revision，再更新 React draft state。
- revision 不以字符串是否变化为判断条件。插入一个空 RoleplayInlineNode 虽然序列化结果仍可能为空，但结构已发生编辑，必须递增。
- 纯光标移动不递增 revision。
- 会话切换重置草稿时同步更新 revision，防止上一会话的异步请求清空新会话草稿。
- Composer 外部 value 更新仍通过现有受控属性恢复编辑器；需要确保显式清空不会因为 value 字符串相同而漏掉，可通过 reset key / draft generation 解决，不引入第二份持久化内容。

### 6.2 submit 行为

1. 保留现有 fatal / online / loaded / mounted / sending / activeRun 校验。
2. 捕获当前已序列化的 draft 文本及 draft revision。
3. 调用现有 send(text)，不修改 GET Session、POST /runs、requestId、expectedTipEntryId。
4. send 成功返回 runId 后，只有当 revision 与提交前一致，才调用 updateDraft('')。
5. revision 已变化时，说明用户在请求期间继续编辑，保留当前内容。
6. 请求失败或抛错时保留原草稿，继续使用现有错误反馈。
7. POST 成功后模型生成失败或被停止，也不恢复旧草稿。
8. 不在点击瞬间清空，避免网络请求失败时丢失用户输入。

### 6.3 SSE 生命周期

- 删除仅为延迟清空服务的 submittedDraft 逻辑。
- 删除 terminalOutcomes 中仅服务于草稿清空的读写。
- 保留 terminal Set 及 run.created / run.completed / run.failed / run.stopped 的 activeRun、重复事件和先后顺序处理。
- run.completed / failed / stopped 不再修改草稿。
- 保留现有 run.failed 通知与停止逻辑，不扩展平台通知范围。
- 处理 SSE 终态事件先于 POST 响应到达的情况：POST 成功后仍按 revision 决定清空；Run 状态仍按现有 terminal 逻辑收敛。

## 7. 变更文件清单

| 文件 | 改动 |
|---|---|
| apps/web/src/features/sessions/composer/RoleplayComposer.tsx | 改为 Inline 节点树；插入、选区、方向键、外部 Draft 恢复；生成 Block Serializer 输入 |
| apps/web/src/features/sessions/composer/roleplay-nodes.ts | 将 thought / speech 改为可编辑 Inline TextNode；instruction 保留唯一尾部块级节点；删除旧的 thought / speech ParagraphNode 模型 |
| apps/web/src/features/sessions/composer/roleplay-composer.css | 改为 Inline thought / speech 样式；重做独立 instruction 尾部区域；移除旧块级语义样式 |
| packages/sr-roleplay/src/index.ts 或新增 composer-projection.ts | 增加复用现有解析结果的 Block 到 Inline segments 投影，不改变现有协议 |
| packages/sr-roleplay/test/protocol.test.ts 或新增 composer-projection.test.ts | 增加 Inline projection、保护范围、顺序、UTF-16 offset 与 round-trip 测试 |
| apps/web/src/host.tsx | 增加 draft revision；POST 成功返回后立即清空；移除 SSE 延迟清空 |
| apps/web/test/composer/test.tsx | 覆盖 Inline 插入、编辑、退出、指令尾部、序列化和恢复 |
| apps/web/test/host-roleplay/test.tsx | 覆盖立即清空、失败保留、并发新输入保护和 SSE 竞态 |

不改 Server、数据库、Run API、SDK 公共 API、WorldStory MessageContent、System Main、Provider、模型上下文预算、世界卡格式或旧消息兼容逻辑。若实现中发现必须扩展共享协议包，限于新增编辑器投影 API，不修改 SR-RP v1 的 wire format。

## 8. 自动化测试与验收标准

### 8.1 Inline Composer 浏览器测试

通过现有 apps/web/test/composer/run.mjs 启动真实 Chrome Headless 测试。

基础插入：

1. 空编辑器点击内心：创建 Inline RoleplayInlineNode(kind=thought)，不产生独立 thought 段落或额外空行。
2. 空编辑器点击话语：创建 Inline RoleplayInlineNode(kind=speech)，不产生独立 speech 段落或额外空行。
3. 有文本时在开头、中间、末尾点击内心 / 话语：均在当前光标处插入，不拆成独立段落。
4. 插入后直接输入，文本属于当前语义节点。
5. 通过方向键越过特殊节点后继续输入，后续文本属于 action。
6. 在特殊节点中间编辑或删除，节点拆分后的语义类型正确。
7. 选区跨 action / thought / speech 时替换、删除和保留选区外文本正确。
8. 同一段落可以混合任意数量的 action / thought / speech。
9. Inline 节点不会阻断 Enter、Shift+Enter 和 IME composing 行为。

叙事指令：

10. 空编辑器点击叙事指令，指令区域出现在正文尾部。
11. 已有正文时点击叙事指令，区域追加在正文末尾。
12. 重复点击定位到同一个区域，不增加第二个空区域。
13. 从指令区域回到正文编辑，指令仍保持尾部。
14. 指令为空时不产生协议内容；指令多行编辑与粘贴正常。
15. 多个外部 instruction 标签恢复为一个尾部区域，顺序和文本不丢失。

双向转换：

16. Inline action + thought + action + speech + action 序列化为正确 SR-RP v1 Block 文本。
17. 发送后的 Block 文本重新进入 Composer 时，恢复为 Inline 语义节点。
18. Block → Inline → Block round-trip 后，语义类型、字符顺序、标点、emoji 和有效换行一致。
19. 代码块、HTML 属性、HTML 内容、Markdown 引用和字面 sr_instruction 不会误识别。
20. action 文本中的合法 inline speech ranges 能恢复成 RoleplayInlineNode(kind=speech)。
21. speech 后的标点不产生孤立 action Block；前置叙事文本不被并入 speech。
22. 外部 setDraft 更新能替换整棵节点树，且不恢复失效 Selection。

编辑器工程行为：

23. 中文 IME composition 不丢字、不重复、不提前发送。
24. 方向键、鼠标点击、Home / End、Backspace / Delete 跨节点行为符合原生编辑预期。
25. 撤销 / 重做对节点插入、文本编辑和删除有效。
26. 内部复制粘贴保留语义节点类型；外部纯文本粘贴按 action 处理，除非已有明确的协议文本导入入口。
27. 320px、375px、768px、1280px 下无横向溢出；浅色和深色对比度达标。

断言不只检查可见 DOM，还必须检查：
- Lexical 节点类型及其顺序；
- Host 收到的 SR-RP v1 字符串；
- parseRoleplay / composer projection 的恢复结果；
- 空节点不会产生消息内容，但会触发编辑 revision。

### 8.2 Host 发送流程浏览器测试

通过 apps/web/test/host-roleplay/test.tsx 的 Fake API / Fake EventSource 增加可控延迟与失败响应：

1. POST 成功返回 runId 后立即清空已提交草稿，不等待 run.completed。
2. POST 网络失败或服务端拒绝时保留原草稿。
3. POST pending 时用户输入新内容；POST 成功后保留新内容。
4. 用户编辑后又恢复成原字符串，revision 仍变化，不能误清空。
5. POST 成功后收到 run.completed，不重复修改草稿。
6. POST 成功后收到 run.failed / run.stopped，不恢复旧草稿。
7. POST 成功后用户继续输入，后续 SSE 终态事件不清空新草稿。
8. SSE 终态先于 POST 响应到达，仍正确清空已提交内容，activeRun 不卡死。
9. 发送期间创建空 Inline 节点，虽然序列化文本未变，revision 仍能阻止旧请求清空当前编辑器结构。
10. 会话切换时上一会话尚未完成的请求不能清空新会话草稿。

### 8.3 协议与服务端防回归

- 现有 packages/sr-roleplay/test/protocol.test.ts 全部通过。
- serializeRoleplay 和 parseRoleplay 的现有 SR-RP v1 行为不变。
- 现有 System Main、世界书激活、状态审查和模型 User Prompt 仍接收 Block 文本。
- User Entry 持久化仍是单条 User Entry，不增加新的 Entry 类型或字段。
- SR.WorldStory 仍把 thought / speech / instruction 作为 Block 语义展示。
- 不需要旧消息迁移；旧消息兼容策略沿用当前项目决策。

### 8.4 工程验证命令

在仓库根目录执行：

    node --experimental-strip-types --test packages/sr-roleplay/test/protocol.test.ts
    pnpm --filter @sillyrealms/web typecheck
    pnpm --filter @sillyrealms/web build
    git diff --check

本次不运行 apps/web/test/composer/run.mjs，也不运行任何浏览器回归；由用户手动检查编辑器交互、光标、输入法和移动端表现。

### 8.5 完成标准

- 编辑器中的 thought / speech 真正是 Inline 可编辑节点，不是 CSS 伪装的块级节点。
- 空输入和非空输入插入都不产生额外空行。
- Inline 节点前后可以自然编辑 action。
- 叙事指令始终处于唯一尾部区域。
- Inline → Block 序列化符合 SR-RP v1，发送、持久化、模型上下文和 WorldStory 均保持 Block。
- Block → Inline 恢复不会误识别代码 / HTML / Markdown 中的字面语法。
- Host 在 POST 成功返回后立即清空未修改草稿；失败保留；并发新输入不丢失。
- 类型检查、构建和协议测试通过；浏览器交互由用户手动回归，本次不执行自动浏览器测试。
- 不覆盖或清理工作区其他未提交改动。

## 9. 执行顺序

1. **基线检查**：重新检查 git status 和目标文件 diff；当前工作区存在大量未提交改动，禁止 reset、checkout、clean、格式化无关文件或覆盖其他 Agent 修改。
2. **先完成内容模型与纯函数投影**：设计 RoleplayInlineNode / RoleplayInstructionNode；补充 Block 到 Inline segments 的共享解析投影和单测。先验证 parser 能正确处理现有协议边界。
3. **实现 Inline Composer**：重写节点注册、快捷按钮插入、选区、方向键、尾部指令区域和 CSS；保持现有 Enter / Shift+Enter / IME 规则。
4. **实现 Serializer / Draft 恢复**：遍历 Lexical 节点生成 RoleplayBlock[]；外部 Block Draft 解析后恢复 Inline 节点树；增加 round-trip 测试。
5. **修复 Host 发送清空**：统一 draft 更新入口和 revision；POST 成功后按 revision 清空；删除 SSE 延迟清空职责。
6. **简单验证**：运行 SR-RP 协议单测、Web typecheck 和 Web production build；不执行浏览器回归。
7. **最终审查**：检查目标文件 diff、协议兼容、用户输入丢失风险和现有世界卡自定义 UI；交互细节由用户手动验收。
8. **汇报**：列出变更文件、真实执行的测试、未执行项目和剩余风险。不自动提交或推送。

## 10. 风险与处理

| 风险 | 处理 |
|---|---|
| 自定义 TextNode 被 Lexical 自动合并或拆分后丢失 kind | 实现 clone / split / insertNewAfter 等语义保持逻辑，并在锁定的 Lexical 0.53 版本实测 |
| Inline 节点边界导致光标无法进入普通文本 | 插入后确保后继 action TextNode 存在；优先使用 Lexical 原生导航，必要时增加局部 ArrowRight 行为 |
| IME composition 跨节点异常 | 不在 composition 期间替换节点或强制归一化；用真实中文输入法回归 |
| Block → Inline 解析丢失 inline speech | 新增 Composer projection，复用 parseRoleplay 的 ranges 和保护规则 |
| 原消息中的块间空行在编辑器中折叠 | 明确块间空行属于 Block 展示分隔；编辑器恢复为 Inline 叙事流，保留片段文本和片段内部换行 |
| 标点落在 speech 节点之外 | 通过紧邻标点归属规则合并；只处理标点-only 邻接片段，不吞并实际 action |
| 复制粘贴丢失语义 | 内部富文本复制保留 kind；外部纯文本粘贴作为 action；增加手动回归检查项 |
| 指令区域被正文编辑移动到中间 | RoleplayInstructionNode 由 Composer 统一维护在 Root 尾部；每次结构更新进行受控归一化 |
| 空节点没有改变序列化字符串 | OnChange 仍向 Host 发出编辑变更，Host revision 独立递增 |
| POST 成功与 SSE 终态事件竞态 | 清空只依赖 POST 成功与 revision；Run 状态仍由现有 terminal Set 收敛 |
| 请求超时但 Server 可能已接受 | 客户端未收到成功响应时保留草稿，不自动重发，也不声称服务端一定未执行 |

## 11. 明确不做

- 不改变 SR-RP v1 wire format。
- 不改变 Server Run API、Entry 数据模型、数据库或会话历史分页。
- 不改变 System Main、Preset、Provider、状态引擎、世界书激活或模型预算。
- 不改变 SR.WorldStory 已发送消息的 Block 渲染和混合 Markdown / HTML 管线。
- 不重写 SDK 公共 API、iframe 安全边界或 Creator UI。
- 不增加新依赖，不重构无关页面。
- 不迁移或兼容用户明确不需要的旧消息格式。
- 不处理模型错误通知或平台通知展示。
- 不提交、不推送，不清理、不覆盖工作区已有未提交改动。

---

**最终结论**：采用「Inline Composer + Block Serializer + 尾部 RoleplayInstructionNode」架构。代码已按该方案实施，保持 SR-RP v1 wire format 不变。协议单测、Web typecheck 和 production build 已通过；浏览器回归按用户要求跳过，等待用户手动验收。

## 12. 实施后修复：空 Inline 节点的可编辑光标

首次手动验收发现：点击「内心」或「话语」后只显示窄色块，无法在 Inline 内输入。原因是空的自定义 TextNode 没有实际 DOM 文本节点，浏览器无法可靠建立原生文本光标。

修复：
- 插入 Inline 时写入 U+200B 零宽占位字符，并将 Lexical 选区定位到占位字符之前。
- 空占位节点移除 padding 和背景，避免显示为窄色块；输入真实内容后恢复语义样式。
- Composer 在构建 RoleplayBlock 前过滤占位字符，确保不进入 SR-RP v1 wire format、草稿文本和模型上下文。
- 增加 Lexical headless 选区测试、占位符过滤测试，并在浏览器回归用例中加入真实输入与选区断言；本次仍按用户要求不运行浏览器回归。

验证：占位符测试 3/3、SR-RP 协议测试 18/18、Web typecheck、production build 均通过。

