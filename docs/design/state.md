# 状态管理：强类型状态树、语义变更与完整状态

> **职责与权威范围**：状态定义、作用域、工作状态、模型与脚本变更语义的权威来源；持久化结构以存储规范为准。

> 2026-11-04 目标设计，**尚未实现**。本文为 SillyRealms 状态唯一权威规范，替代旧的基于 `initial` 推断类型、`world/user` 运行值、MVU `<UpdateVariable>` 和模型直接提交 RFC 6902 JSON Patch 的方案。背景决策与测试计划见工作区 `plan/realms-typed-state-redesign-design.md` / `-tasks.md`。其中动态工具 Schema、长叙事 Tool Call 流式及 Provider 兼容性仍须 PoC，不能标称已验证。

## 1. 目标、取舍及术语

- **作者只负责业务含义**：使用可视化编辑器创建「名称、类型、初始值、描述」，可选设置数值上下限、枚举、可空和加载规则；作者不需要理解 Zod、Tool Schema 或内部更新协议。
- **单一类型定义**：当前世界卡中的 `data.state` 是受限、可序列化的定义 AST；编译器从同一 AST 分别生成 Zod 校验器、用于 Provider 的 JSON Schema 与运行时工具目标。不要把运行时 Zod 代码存入状态定义；世界书、角色描述和预设的 EJS/JS 脚本按独立脚本契约保存，不依赖实验性 `z.fromJSONSchema` 作为关键反向转换。
- **Schema 约束的是数据形状**，`description` 约束剧情语义；类型正确不等于叙事、数值演变正确。严格拒绝违反显式类型/范围的状态值，不擅自把错误数字夹回范围。
- **写入不是通用 JSON Patch**：模型通过类型受限的 ChangeSet 描述少量变化，服务端执行并验证；可在诊断层导出差异 Patch，但 **RFC 6902 六操作不是模型协议**。对作者与模型统一使用 Lodash 路径，状态操作必须显式指定作用域。
- **状态均持久化**：Global 归属单张世界卡、Session 归属单个会话、Message 归属消息分支；分别保存于 `worlds.state`、`sessions.state` 和 `entries.state`。局部变量和 Run 临时变量不持久化。格式与合并规则见[存储](../technical/storage.md)。
- 状态是可选插件。未定义状态的世界不必调用状态工具，也不注入状态协议。状态 UI 由应用渲染；EJS/JS 在隔离运行环境中按脚本契约执行。

## 2. 世界卡定义：显式类型树

### 2.1 唯一数据结构

`data.state = { "schema_version": 1, "scopes": { "global": {"modules": {}}, "session": {"modules": {}}, "message": {"modules": {}} } }`。三个 scope 可省略（缺省为空），各自 `modules` 的名字对应该作用域运行状态顶层键；根 Module 必须为 object，根上可配置可选 `load`（默认 always），不能为内部字段独立配置加载条件。根可代表世界、角色、地点、组织或任务，并不自动表示玩家身份。缺省 `data.state` 相当于无状态。

支持的节点：
| `type` | 数据含义 | 定义属性 | 更新约束 |
| --- | --- | --- | --- |
| `string` | 字符串 | `initial`, `description?`, `nullable?` | `set` |
| `number` / `integer` | 有限数 / 整数 | `initial`, `min?`, `max?`, `description?`, `nullable?` | `set/adjust`；nullable 时 adjust 仅在现值为数字时允许 |
| `boolean` | 布尔 | `initial`, `description?`, `nullable?` | `set` |
| `enum` | 枚举字符串 | `values` 至少一个、无重复；`initial`, `description?`, `nullable?` | `set` |
| `object` | 固定字段结构 | `properties` 字段映射、`description?` | 递归更新已声明字段；不增删固定子字段 |
| `array` | 有序同类列表 | `items` 子节点 Schema、`initial` 数组、`description?` | `append`；确需整体重写可按受限 `set` 校验 |
| `json` | 自由 JSON 逃生口 | `initial` 合法 JSON、`description?` | 仅整体 `set`，不承诺内部类型 |

- 所有**静态状态叶子**都必须有 `initial`；`object.properties` 递归生成初始对象，不要求作者重复提交整份初值。处于 `array.items` 的子节点用于验证新元素，其静态叶子初值**可以省略**；`append` 必须提供符合 Schema 的完整 item，不暗中补默认字段。
- `nullable` 允许 `null`，不等于字段可以缺席。MVP 不支持 optional、union、判别联合、正则或任意用户自定义函数。所有固定 object 字段必需且禁止额外键。
- 数字只接受有限数字；整数、枚举、min/max 作为**硬约束**。`description` 是唯一自然语言变化原则，不另设易混淆的 `rule`；缺少描述可为空串，不代表程序保证剧情合理。
- `object`、`array` 可以嵌套，嵌套深度、字段个数、JSON 字节和 Tool Schema 字节有实现侧上限，编辑验证时报错而非截断。标识符为非空字符串，允许中文和点号；路径使用 Lodash 规则；特殊键名可用字符串数组路径避免歧义。
- `json` 刻意弱类型。编辑器显著提示该字段不享有内部强类型更新能力，不应为方便而把整棵复杂状态全部放进自由 JSON。

### 2.2 完整示例

```json
{
  "schema_version": 1,
  "scopes": {
    "global": {"modules": {"首页": {"type": "object", "properties": {"公告": {"type": "string", "initial": "欢迎来到这个世界", "description": "世界卡首页公告"}}}}},
    "session": {"modules": {"偏好": {"type": "object", "properties": {"显示模式": {"type": "string", "initial": "完整"}}}}},
    "message": {"modules": {
    "世界": {
      "type": "object",
      "load": {"mode": "always"},
      "properties": {
        "时间": {"type": "enum", "values": ["白天", "夜晚"], "initial": "白天", "description": "剧情实际推进时间时更新"}
      }
    },
    "清月": {
      "type": "object",
      "load": {"mode": "on_mention", "keywords": ["清月", "仙子"]},
      "properties": {
        "灵力": {"type": "integer", "min": 0, "max": 100, "initial": 100, "description": "施法消耗，休息可能恢复"},
        "心情": {"type": "string", "initial": "平静", "description": "按已发生的剧情判断"},
        "身体": {"type": "object", "properties": {
          "伤势": {"type": "string", "nullable": true, "initial": null, "description": "无伤时为 null"}
        }},
        "背包": {
          "type": "json",
          "description": "键是物品 ID，物品变化时整体更新背包",
          "initial": {"灵石": {"数量": 3, "说明": "随身携带"}}
        }
      }
    }
  }}
  }
}
```

Message 初始运行值（逻辑对象视图，Entry 的 state 列仍保存根 key/value 数组；Global 与 Session 分别独立存储）：

```json
{"世界":{"时间":"白天"},"清月":{"灵力":100,"心情":"平静","身体":{"伤势":null},"背包":{"灵石":{"数量":3,"说明":"随身携带"}}}}
```

### 2.3 世界卡、角色与开局的关系

- 世界卡在 `data.state.scopes` 分别声明三个作用域的状态树；不再运行时拼接 `world/user`，不隐式生成虚拟 `全局` 或选中角色的 `user` 状态。
- `characters[]` 仍负责角色设定、角色 ID 和可扮演许可。原有 `characters[].state` 属于**旧格式导入数据**；迁移时由导入器/作者显式映射到 `data.state.scopes.message.modules[目标根名称]`，处理重名与类型冲突，不能悄悄合并或只加载玩家角色的状态。选中的 `user` 只是 Session 的角色身份，并非状态根的特殊命名空间。
- Opening 的 `initial_state` 只覆盖 Message 初值，是与消息运行值同形的**部分对象覆盖**：沿固定 `object` 递归到已定义叶子；`array/json` 叶子只能整体替换，不能把对象初值误当成深合并。所有覆盖值由 Zod 完整验证；未知键、额外固定字段、类型错误阻止开局初始化。
- 创建世界卡时以 global 定义初始化 `worlds.state`；创建 Session 时以 session 定义初始化 `sessions.state`，并以 message 定义及 Opening 覆盖构建 S0 写入根 Assistant Entry 的 `state` 列；**Session 不复制 Schema 或世界快照**。世界卡定义变更若使现有状态不兼容，应提示并阻止使用该状态，保留原值；经用户明确选择并备份后，才可按方案迁移或重建。

## 3. 创作者 UI 与导入

默认编辑视图是一棵可展开的状态树；作者添加「字段/对象/列表」，只需看**字段名、类型、默认值、描述**。数字范围、枚举项、可为空等在高级设置。对象内新增固定字段；列表配置 item 结构与有序初值；预览区实时给出实际运行 JSON、完整路径及类型错误。

可从示例 JSON 生成建议定义，但空数组、空字典、null、数组混合类型均需作者确认；不能以猜测结果直接保存为可用定义。创建 Session/编辑状态时必须验证定义、所有初值、Opening 覆盖及编译后的 Schema；作者不用手写工具调用、路径枚举或更新操作。

## 4. 类型引擎和安全边界

- 服务端目标 Hono/TypeScript，使用 **Zod** 验证。受限定义 AST 是存储事实来源，直接编译出运行校验器；另编译为通用 JSON Schema/Provider strict 子集，不依赖 Zod 反向解析任意 JSON Schema。
- 用每次运行时从最新世界卡读取的 Schema 检查初始状态、每个操作参数及本轮最终完整状态；失败返回具体路径、期待类型、实际值和操作索引。JSON Schema 对 Provider 是减少错误的生成提示，不取代服务端 Zod 验证。
- 避免原型污染和路径混淆：以安全字典处理 `__proto__`、`constructor` 等键，严格解析 Lodash 路径、拒绝危险属性并检查目标存在性；限制键名、深度、条目数、变更数与字节大小。拒绝未知固定字段与整个根/模块写入。
- 状态管理只保证结构约束与提交一致性；不会根据自然语言描述自动修正剧情、推断不确定的值，或调用额外隐形模型补状态。

## 5. 模型更新协议：ChangeSet

模型不直接生成任意 JSON Patch；统一内部协议是 `changes: StateChange[]`，**所有状态变更项必须有非空 reason 描述**，供状态栏解释变化。模型仅可更新 Message，模型变化按顺序作用于 Prompt 脚本更新后的 Message 完整工作状态，全部通过后才能提交完整 S'。

| op | 参数 | 语义 |
| --- | --- | --- |
| `set` | `scope, target, value` | 设置已声明的标量/可空/枚举或有容量限制的整块 `json/array` 叶子；不替换固定 object 根/分组 |
| `adjust` | `scope, target, delta` | 对已声明 number/integer 做加减，计算后的值必须通过 min/max、整数校验；原值为 null 时拒绝 |
| `append` | `scope, target, item` | 只向已声明数组末尾追加一个符合 items Schema 的完整元素 |

所有操作（set/adjust/append）都必须带 `reason: string`，说明对应变化在叙事中的原因。`reason` 是模型的说明而不是程序可证明的事实；程序校验类型、非空字符串和目标状态约束。没有变化时使用 `changes: []`，不需要凭空编造说明。

模型 ChangeSet 的 `scope` 必须为 `message`；脚本 `setState` 可显式指定 `global`、`session` 或 `message`；`target` 为 Lodash 路径，例如 `清月.灵力`、`清月.背包`。`json` 仅支持整体 `set`；动态键数据可存入 `json`，增删成员时提交完整新值，内部结构不做强类型校验。首期不提供数组按索引删除或移动。

示例（假设回春丹事先在背包中且灵力不会超限）：

```json
{
  "narrative": "清月服下回春丹，灵力恢复十点。",
  "changes": [
    {"op": "adjust", "scope": "message", "target": "清月.灵力", "delta": 10, "reason": "服用回春丹，灵力恢复"},
    {"op": "set", "scope": "message", "target": "清月.背包", "value": {"灵石": {"数量": 3, "说明": "随身携带"}}, "reason": "回春丹已经服用"}
  ]
}
```

`[]` 表示模型**明确无变化**，不等于未返回状态更新。引擎须校验最终数值仍满足类型和范围；任何一个操作失败，整个 ChangeSet 不提交部分结果。没有 `set/add/insert/delete/move` 的 MVU 兼容执行通道。

### 5.1 Tool Call 优先，但能力门槛必须实测

目标工具 `submit_turn` 接收 `{narrative: string, changes: StateChange[]}`，以**一次模型生成输出**承载叙事与增量状态。工具描述由 StateService 从**本轮已激活、允许写入的状态 Module（StateScope）** 动态编译，尽量为每个 op/target 生成类型受限的 JSON Schema 分支：例如 `message:清月.灵力` 的 delta 必须是数字，`message:清月.背包` 的 set value 必须是合法 JSON；`target` 优先固定枚举而非裸字符串。模型没有看到/未激活的 Module 默认不可写，仍始终存在于完整状态中。

动态 Schema 需要限制枚举目标数量、嵌套深度和总输入 Token。不同模型/Provider 对 `anyOf`、严格工具、复杂嵌套、工具参数流式支持不同，不能假设任何模型都能一次请求完成且无损逐字流式展示长叙事。底层调用尽量使用 Pi 内置实现，ProviderService 负责查询/校验模型能力而不是为各供应商重复写 Adapter。**只对实际模型 PoC 验证过的模型开启工具模式**；未验证时使用明确选定的内联模式或报不支持，不在生成中途静默切换协议。无论生成侧是否声称 strict，服务端始终执行完整验证。

### 5.2 内联回退

流式文本能力优先或 Provider 无法稳定调用结构化工具时，模型回复正文后仅允许**一个末尾** `<StateUpdate>`，其中为合法 JSON `{"changes":[...]}`，与 Tool Call 进入同一 ChangeSet 校验器：

```text
清月缓缓放下剑。

<StateUpdate>
{"changes":[{"op":"set","scope":"message","target":"清月.心情","value":"放松","reason":"战斗结束后清月放松了下来"}]}
</StateUpdate>
```

严格拦截分段标签避免流式露出，块中不允许 Markdown 围栏或其他文本；原始输出与清洗后的正文分开存储，更新块不回注后续聊天历史。缺失块状态为 `missing`，重复、提前出现、未闭合、非法 JSON 或模型中断为 `invalid`，不解释成 `[]`。每轮只选择 tool/inline 之一，不重复执行；工具返回是否需要后续模型请求是 Provider/Pi 的待验证能力，协议不承诺零续轮。**重要**：`submit_turn` 的 `narrative` 可能仅存在于 Assistant 的 ToolCall 参数中；原始 Assistant ToolCall 和 ToolResult 仍须全部持久化。若本轮没有另行生成最终可见的 Assistant 叙事，则在状态校验成功后，将该 narrative 按原文写成一条 `origin=derived_tool_narrative` 的规范化 Assistant Entry；模型下轮历史只读取其叙事 text，不回放旧工具参数或 ToolResult，且已有独立 Assistant 正文时不能重复追加。

## 6. 加载、读取与模板

### 6.1 状态根与世界书的条件加载

状态根 `load` 默认 `{"mode":"always"}`，仅支持 `always` 与 `on_mention`；**不支持 manual**。关键词检测使用压缩前候选叙事及当前 User：Window 先取最近 N 条；Summary 使用已有最新摘要与未覆盖原文。本轮新摘要不参与扫描，预算裁剪后不重匹配。`on_mention` 使用 `keywords`、`keyword_logic:any|all`、`exclude_keywords`，基础条件未命中则不加载。

若存在 `when`，它是附加的 **AND 条件**：`active = modeMatched && evaluateWhen(fullState)`。`always + when` 必须满足 when；`on_mention + when` 必须同时命中关键词且 when=true；排除词命中一票否决。`when` 对当前世界线最新**完整状态**求值，不能用筛选出来的局部状态代替全量 State。统一加载判断由 [ContentActivation](content-activation.md) 执行，条件由独立 [ExpressionEngine](script-runtime.md) 求值。

各作用域的状态根以 `(scope, 根名称)` 唯一标识；激活后，其描述与当前值进入 `worldState` NodeBuilder，也用于构造受限状态更新 Tool Schema；未激活的根仍留在全量状态中，但不默认暴露给模型或允许更新。候选历史选择及工具消息过滤决定关键词来源，**不改变完整状态的读取**。

状态栏根据全量状态展示字段，不取决于状态根是否加载进模型。世界书和状态根的匹配范围完全一致，不独立设置 Preset scan_depth。

### 6.2 状态 API、EJS 与变量

状态脚本使用 JavaScript；文本模板使用 EJS，加载条件为 JavaScript 表达式。`getState` 可省略 scope，按 global → session → message 查找；`setState` 的 scope 必填。示例：`getState("清月.灵力", {scope:"message"})`、`getState("首页.公告", {scope:"global"})`；`setState(path, value, {scope})` 在允许写入的阶段提交变更。路径遵循 Lodash，特殊键可用路径数组，如 `["清月", "衣服.外套"]`；拒绝 `__proto__`、`prototype`、`constructor` 等危险路径。缺失值与 null 区分，缺失时返回 undefined，可用 JS `??` 指定默认值。状态接口属于可扩展的 SR API，首期不提供 `getwi/activewi`。

```ejs
<% const 灵力 = getState("清月.灵力", {scope:"message"}) ?? 0; %>
清月灵力：<%- 灵力 %>
<% if (灵力 < 20) { %>清月感到疲惫。<% } %>
```

`const/let` 等局部变量限定在一条世界书条目或一条角色描述的单次执行中，执行结束即销毁；不跨条目共享。`setvar(name, value)` / `getvar(name)` 只读写同一 Run 的临时变量表，可跨世界书条目、角色描述和预设模板共享；按照节点与条目确定顺序读到先前的成功写入，未设置时返回空字符串 `""`，0、false 和 null 原样返回；Run 成功、失败、取消后销毁，重试或重生成创建新的表，不进入任何 state 列。预览使用独立临时表并在结束销毁。加载判断先于正文渲染，不能读取后续条目才写入的临时变量；`when` 仅读状态，不允许 `setvar` 或 `setState`。EJS 普通渲染可按 scope 通过 `setState` 更新本轮工作状态，后续脚本立即可见；不直接写数据库。worldState 本体最后只读生成，Run 成功后才统一提交。

JavaScript 引擎与 EJS 的版本及系统 API 要明确固定；`getState/setState` 是宿主提供的 SR API，语言能力不等于开放文件、网络、数据库或进程。脚本在受资源限制的独立隔离环境中执行，超时、错误或资源超限返回可定位诊断，不提交状态；Node `vm` 本身不是安全边界。详情见[表达式与脚本](script-runtime.md)和[文本渲染](text-rendering.md)。

### 6.3 本轮工作状态与最终持久化

Run 开始分别复制 Global、Session、Message 已提交状态，生成三份相互独立的工作状态；Message 来自当前父链最近有效完整状态。所有 `when` 在普通 Prompt 脚本前只读初始视图并冻结匹配。Prompt 脚本按确定顺序执行 `setState`，更新工作状态；未加载给模型的状态仍保留在完整工作状态中。状态展示只是工作状态的筛选视图，不得把筛选结果当作完整状态覆盖保存。所有普通 Prompt 完成后，在预留的 worldState 位置只读生成最新值及描述，再完成预算检查，之后 Agent 执行。Agent 只对 Message 提交部分字段变更；按实际顺序应用到脚本更新后的完整 Message 工作状态，保留 AI 未涉及的字段。脚本和模型修改同一字段时后续操作按其语义覆盖或调整。

Run 整体成功后在一个事务提交最终 Global、Session、Message 工作状态；Message 写入新 Assistant Entry，不回写父消息。失败、取消、校验或版本冲突丢弃本轮未提交的状态，不影响历史；预览使用隔离副本并丢弃。若未来增加 Agent 后脚本，它们在持久化前按实际顺序作用于同一工作状态。

## 7. 状态结算、完整 Agent 消息和世界卡更新

1. 创建世界卡时初始化 `worlds.state`；创建 Session 时初始化 `sessions.state`，Opening 初始 Message 状态保存于根 Entry 的 `state` 列。
2. 玩家输入是新的 User Message Entry；Assistant 生成可能有多个包含 `toolCall` 块的完整消息，并可能产生独立 `toolResult` Message Entry。**每条真实 Pi 消息都按原样持久化**，不可把工具消息仅留在内存或作为可选日志。
3. AgentContext 在 Run 开始读取世界卡 Global、Session 状态及当前 parent_id 父链最近有效 Message 状态，固定本轮读取视图；Prompt 历史裁剪不影响读取。
4. 模型输出叙事和 `StateChange[]`，每项 Change 强制 `reason`。StateEngine 在脚本更新后的完整 Message 工作状态上顺序应用并验证模型部分变更和最终新状态；跨作用域候选变更使用同一事务、版本检查和状态验证；工具返回不是已结算状态，失败时不将非法更改标记为成功。
5. 生成成功后，将完整 S' 编码为 state 数组写入最终 Assistant Message Entry，含 reason 的变更元数据写入 ext_data（必要时为由终止型 ToolCall.narrative 规范化生成的 Assistant Entry）。`off` 仅关闭模型状态更新，不丢弃 Prompt 脚本对工作状态的变更；`changes: []` 同样保留脚本更新后的完整状态。Chat UI/新模型历史只提取 user/assistant **叙事文本**，剔除 ToolCall/ToolResult、思维块及内联状态标记；但 Raw Entries 保留原始 ToolCall/ToolResult。
6. **世界卡定义使用最新版本**：若新的 `worlds.data_json` Schema 与既有 Global、Session 或 Message 状态不兼容，保留所有旧数据，提示冲突并暂停依赖该状态的执行；只有用户明确选择且已备份后才进行迁移或重建。重建记录 `stateReset`；不得覆盖历史消息状态。
7. 多分支从当前 tip 的真实父链取状态，不能从数据库全局最近 Entry 或另一个分支取值。对有后代的历史编辑/重新生成，不静默重写后代状态；可通过新分支保存新的输出。

SQLite `worlds.state` 与 `sessions.state` 持久化对应状态，`entries.payload` 保存 Pi 原生内容，`entries.state` 保存完成 Assistant 的完整状态数组，`entries.ext_data` 保存变更元数据；`sessions` 通过 `world_id/preset_id/user_character_id/tip_entry_id` 建立关联，并保存自身 state。**不建 run_tool_calls/runs/messages 独立表，不用 Session 世界快照或 selected_run_id。**

## 8. 验收与未解决问题

- 类型：初始化所有基础类型、null、嵌套对象、array、JSON 逃生口、错误初值、Opening 部分覆盖、min/max/enum、额外键拒绝。
- 更新：三种操作的路径白名单、自由 JSON 整体替换、数组追加、数值区间、顺序、任何错误整组回滚，生成中断不部分提交。
- 一致性：消息级 Entry 的真实 parent_id 分叉、Assistant 重新生成/工具消息顺序、无变化也保存完整状态；本地 MVP 不引入复杂 revision 矩阵。
- StateReader/ExpressionEngine：状态引用、`getState/setState`、EJS 条件和 Run 临时变量、世界书 when、状态根 load 与预览一致；ContentActivation 统一匹配；Prompt 脚本只更新工作状态，不在构建时持久化；worldState 本体只读。
- **Provider PoC 必须优先完成**：至少两类 Provider 的 strict Tool 支持、复杂 Schema 通过率、长篇 narrative 流式表现、内联失败率、输出正确率及输入/输出 Token、延迟和语义更新召回率。选择正式默认通道前必须量化，不能只看 JSON 合法率。
- **迁移清单**：旧 `characters[].state` 显式并入统一 `data.state`，旧 `world/user` 快照须明确转换，旧 MVU / RFC6902 更新协议不自动兼容；升级旧格式前检查当前世界卡、Opening、`entries.payload`，先备份再迁移；新 WorldCard Schema 不兼容时提示用户明确选择迁移或重建，保留旧数据。

外部参考：[Zod JSON Schema](https://zod.dev/json-schema)、[JSON Schema](https://json-schema.org/)、[RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)、[RFC 6902](https://www.rfc-editor.org/rfc/rfc6902)、[OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)、[Anthropic Tool Use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)。
