# 配置：预设、Prompt 节点与模型连接

> 状态：2026-11-03 MVP 目标设计，尚未实现；强类型状态与输出通道配置已同步。执行流程与扫描算法见[Context](context.md)；数据规范见[世界卡](world-card.md)。

## 所有权与边界

- **Preset** 拥有主节点数组 `nodes[]` 的位置、顺序、开关、角色和文本配置。模型连接、参数及 Token 预算也由选中预设持有。
- **WorldCard** 提供角色、单个 `lorebook`、开局、可选状态字段及内容加载条件。世界书条目只能选择系统允许的四个基础节点的 `before/after` 锚点及同锚点内的 `order`，**不允许配置消息角色**，也不允许改变节点主顺序。
- **ContextManager** 先扫描并选择资料，再沿预设节点顺序构建。命中的同节点锚点资料与该节点本体合并为**一条 Prompt 消息**，角色严格继承该节点；世界书没有独立消息。
- **Session** 绑定世界卡发布快照、本局从世界卡选出的 `user` 角色及本轮实际 Entry 父链。打开聊天最近 30 条不限制模型上下文读取。
- **Pi** 接收构建后的有效上下文，以 `session.prompt(effectiveUserQuery)` 发起本轮生成。Provider 对后置 `system` 的实际重排另行验证，本阶段不解决。

世界卡 `data.description` 用于展示，可为富文本，不进入 Prompt。故事前提、场景规则和示例等需要模型读取的文本由世界书承载；本期不单设 `scenario`、`worldDescription`、`worldInfo`、`sceneInfo`、`dialogueExamples` 节点。

## 默认预设与自定义预设

系统提供 **ID 为 `builtin/default`、不可删除但可编辑** 的默认预设；用户可直接绑定模型连接、修改节点顺序和预算。保留可供显式恢复的出厂快照，恢复需确认且不会自动覆盖用户配置。其他预设可以复制或新建，并绑定相同的模型连接。

预设持久化完整的、有序 `nodes[]`，不得每轮与新的内置模板隐式合并。每次模型生成开始时固定预设、连接、世界与目标 Entry 快照；途中编辑只影响后续生成。导出预设不包含 API Key。

### 七个基础节点

| 稳定 ID | 类型 | 数据来源 | 默认角色 |
| --- | --- | --- | --- |
| `main` | text | 基础叙事指令 | system |
| `personaInfo` | slot | 本局选中 `user` 角色定义快照 | system |
| `characterInfo` | slot | 其它命中的世界卡角色资料 | system |
| `worldState` | slot | 冻结父快照中已激活的强类型 Module 值/描述、当前类型路径及状态更新要求 | system |
| `chatHistory` | slot | 本次 User Entry **之前**的真实祖先历史 | auto（保留原角色） |
| `userInput` | slot | 本次 User Entry 的原始输入 | user（固定） |
| `postHistory` | text | 预设后置文本，可为空 | system |

每份预设七个基础节点各恰好出现一次：不可删除、改 ID、改类型或来源。用户可重新排列节点，但 `chatHistory` 必须在 `userInput` 之前；二者必须启用。`userInput` 固定为 `user`，`chatHistory` 的历史 Entry 不允许被统一改角色；其余节点的角色可以配置为 `system`/`user`/`assistant`。自定义 `text` 节点可增删、移动、设置角色和启停，不允许新增任意来源的 `slot`。

当世界卡 `data.state.modules` 非空时 `worldState` 强制启用，否则阻止生成。禁用其他基础节点只关闭本体内容，**不关闭锚点**；若锚点内容非空，即使本体为空/禁用，该节点仍产生一条继承节点角色的消息。`personaInfo` 的角色定义只来自世界卡选中的角色，不支持个人身份库或外部角色。

基础出厂顺序：

```text
main → personaInfo → characterInfo → worldState
     → chatHistory → userInput → postHistory
```

`postHistory` 默认关闭。这个顺序只是出厂配置，构建时以实际 `nodes[]` 为准。

## 世界书锚点：一节点、一消息、一角色

一张世界卡有一个 `data.lorebook.entries[]`。条目 `load` 定义激活模式及相对锚点：

| 允许的锚点 | 插入位置 | 最终消息角色 |
| --- | --- | --- |
| `personaInfo` | `before` / `after` | 继承 `personaInfo.role` |
| `characterInfo` | `before` / `after` | 继承 `characterInfo.role` |
| `worldState` | `before` / `after` | 继承 `worldState.role` |
| `userInput` | `before` / `after` | 固定 `user` |

没有独立世界书 `role` 字段；旧来源的 `injection_role` 等只作不执行的来源归档，不得参与原生规则。世界书若提供 `load.role` 必须在保存或发布校验时**拒绝**，不能静默忽略后出现两套理解。

**展开语义：** 遍历预设节点 `N` 时，取该锚点的命中条目，按 `before`、节点本体、`after` 三段拼接（非空段用两个换行分隔），**仅生成一条 role = N.role 的 Prompt**；无任何内容则不发消息。同侧条目按 `load.order` 升序，同值保持世界书原始列表顺序（缺省 `0`），即使目标节点无内容或被关闭也保持锚点规则。锚点随着节点拖动而移动，不会跨节点或用户自定义节点排列。

例如 `characterInfo.role = system`：

```text
[characterInfo.before  条目 A / 条目 B]
[characterInfo          角色资料]
[characterInfo.after   条目 C]
→ {role: "system", content: "A\n\nB\n\n角色资料\n\nC"}
```

`userInput` 同理，将锚点文本和原始 User Entry 组合为**一次有效用户输入**，由 `prompt(effectiveUserQuery)` 发送。`entries.content` 只保存用户原文，**不存拼接后的有效 Query**；重试或分叉也不得把锚点文本当成新的用户消息。角色字段来源和构建预览必须能追溯每一段。

### 世界书条目示例

```json
{
  "id": "story-rules",
  "title": "叙事补充规则",
  "content": "根据用户行动详细叙述后续事件。",
  "load": {
    "mode": "always",
    "anchor": "userInput",
    "position": "after",
    "order": 10
  }
}
```

`load.mode` 只允许 `always` / `on_mention` / `manual`；`on_mention` 使用 `keywords`、`keyword_logic: any|all`、`exclude_keywords`；所有模式可设置无副作用的 `when`（读取同一冻结父快照），详见[状态](state.md)。世界书扫描历史与命中细则见[Context](context.md)，MVP 不实现递归、概率、Sticky/Cooldown 或历史内部深度插入。未指定锚点时默认 `characterInfo/after`（旧数据格式迁移时应显式补齐）。

## 预算与模型连接

预算唯一归属当前预设：

```text
input_budget = context_window_tokens - max_output_tokens - safety_margin_tokens
```

先为 `userInput` 原文、已激活的强类型状态和必要状态协议（工具模式需包含动态 Tool Schema 输入 Token）保留空间，再按**构建顺序**依次接受可选内容，遇到第一项超预算便舍弃该项和后续可选内容，不会把超预算片段截成半条。`chatHistory` 是特例：从最新 Entry 向前按完整消息保留连续历史，再按时间正序放回该节点；世界书条目是可单独舍弃的片段，合并节点时重新计数。必需内容放不下则拒绝生成，不截断用户正文。采用预算只是 MVP 规则，不等于已验证模型精确 Tokenizer；具体算法与检查见[Context](context.md)。

预设增加可选 `state_output_mode: auto|tool|inline`（默认 `auto`）：`auto` 只对**已在该 Provider/模型实测验证**的组合选择 `submit_turn`，否则使用内联 `<StateUpdate>`；强制 `tool` 但 Provider 不支持时应报错而非静默降级。实际通道每轮开始时锁定，不可混用，两种通道都提交同一种 ChangeSet；详见[状态](state.md)。

模型连接独立保存服务地址、平台、模型 ID 和 `credential_ref`；多预设可引用同一个连接。运行时在预设快照中锁定连接，API Key 由本地服务管理，不写入世界卡、预设导出或 Prompt 预览。模型不可用时显式报错，不自动更换。

## 验收标准

- 默认预设可编辑但不可删除；每份预设恰有七个基础节点且 `chatHistory` 位于 `userInput` 之前。
- 世界书 **不能设置 role**；锚点 `before/after` 和本体合并成一条 Prompt，严格继承对应节点角色；修改锚点节点角色后，世界书无需改动。
- 节点为空/禁用时仍能加载该锚点；完全无内容才跳过整条消息；移动节点不会把锚点留在旧位置。
- `userInput` 锚点合并后只发送一次有效 Query，SQLite User Entry 保存原文；历史只沿目标分支祖先链。
- 预算预留必需内容及动态 Tool Schema，依构建顺序舍弃可选片段；预览准确指出命中、裁剪、合并归属与估算 Token。
- 本轮不试图解决 Provider 将历史后 `system` 提前合并的现象，相关运行时验证留在 Pi 集成阶段。

## 延后能力

历史压缩与长期记忆、深度插入、动态脚本、完整 SillyTavern 兼容、Provider 角色重排规避与 AI 续写/重生成专用 Prompt 均不属于本轮冻结的 MVP Context 规范。
