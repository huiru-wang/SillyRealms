# 状态管理：强类型状态树、语义变更与完整快照

> 2026-11-04 目标设计，**尚未实现**。本文为 SillyRealms 状态唯一权威规范，替代旧的基于 `initial` 推断类型、`world/user` 运行值、MVU `<UpdateVariable>` 和模型直接提交 RFC 6902 JSON Patch 的方案。背景决策与测试计划见工作区 `plan/realms-typed-state-redesign-design.md` / `-tasks.md`。其中动态工具 Schema、长叙事 Tool Call 流式及 Provider 兼容性仍须 PoC，不能标称已验证。

## 1. 目标、取舍及术语

- **作者只负责业务含义**：使用可视化编辑器创建「名称、类型、初始值、描述」，可选设置数值上下限、枚举、可空和加载规则；作者不需要理解 Zod、Tool Schema、JSON Pointer 或更新操作。
- **单一类型定义**：当前世界卡中的 `data.state` 是受限、可序列化的定义 AST；编译器从同一 AST 分别生成 Zod 校验器、用于 Provider 的 JSON Schema 与运行时工具目标。不要把运行时 Zod 代码、EJS、任意 JS 直接存入世界卡，不依赖实验性 `z.fromJSONSchema` 作为关键反向转换。
- **Schema 约束的是数据形状**，`description` 约束剧情语义；类型正确不等于叙事、数值演变正确。严格拒绝违反显式类型/范围的状态值，不擅自把错误数字夹回范围。
- **写入不是通用 JSON Patch**：模型通过类型受限的 ChangeSet 描述少量变化，服务端执行并验证；可在诊断层导出差异 Patch，但 **RFC 6902 六操作不是模型协议**。JSON Pointer 只用于统一寻址，访问值与更新均遵循该路径。
- **全快照**：每个 `Entry` 的选中成功 `runs[]` 项都保存一份完整运行状态 JSON，Snapshot 不含 `type`、`description`、`initial`、`load`、`global/entities/values` 包装。
- 状态是可选插件。未定义状态的世界不必调用状态工具，也不注入状态协议。状态 UI 由应用渲染，不执行世界卡脚本。

## 2. 世界卡定义：显式类型树

### 2.1 唯一数据结构

`data.state = { "schema_version": 1, "modules": { "<rootName>": <objectNode> } }`。`modules` 的名字直接对应运行快照顶层键；根 Module 必须为 object，根上可配置可选 `load`（默认 always），不能为内部字段独立配置加载条件。根可代表世界、角色、地点、组织或任务，并不自动表示玩家身份。缺省 `data.state` 相当于无状态。

支持的节点：
| `type` | 数据含义 | 定义属性 | 更新约束 |
| --- | --- | --- | --- |
| `string` | 字符串 | `initial`, `description?`, `nullable?` | `set` |
| `number` / `integer` | 有限数 / 整数 | `initial`, `min?`, `max?`, `description?`, `nullable?` | `set/adjust`；nullable 时 adjust 仅在现值为数字时允许 |
| `boolean` | 布尔 | `initial`, `description?`, `nullable?` | `set` |
| `enum` | 枚举字符串 | `values` 至少一个、无重复；`initial`, `description?`, `nullable?` | `set` |
| `object` | 固定字段结构 | `properties` 字段映射、`description?` | 递归更新已声明字段；不增删固定子字段 |
| `record` | 动态键映射 | `value` 子节点 Schema、`initial` 对象、`description?` | `upsert/remove/set_record_field` |
| `array` | 有序同类列表 | `items` 子节点 Schema、`initial` 数组、`description?` | `append`；确需整体重写可按受限 `set` 校验 |
| `json` | 自由 JSON 逃生口 | `initial` 合法 JSON、`description?` | 仅整体 `set`，不承诺内部类型 |

- 所有**静态状态叶子**都必须有 `initial`；`object.properties` 递归生成初始对象，不要求作者重复提交整份初值。处于 `record.value` 或 `array.items` 的子节点用于验证新元素，其静态叶子初值**可以省略**；`upsert/append` 必须提供符合 Schema 的完整 item，不暗中补默认字段。
- `nullable` 允许 `null`，不等于字段可以缺席。MVP 不支持 optional、union、判别联合、正则或任意用户自定义函数。所有固定 object 字段必需且禁止额外键；`record` 可以动态增加或删除键。
- 数字只接受有限数字；整数、枚举、min/max 作为**硬约束**。`description` 是唯一自然语言变化原则，不另设易混淆的 `rule`；缺少描述可为空串，不代表程序保证剧情合理。
- `object`、`record`、`array` 可以嵌套，嵌套深度、字段个数、JSON 字节和 Tool Schema 字节有实现侧上限，编辑验证时报错而非截断。标识符为非空字符串，允许中文和点号；指针路径中 `~` 转义 `~0`、`/` 转义 `~1`。
- `json` 刻意弱类型。编辑器显著提示该字段不享有内部强类型更新能力，不应为方便而把整棵复杂状态全部放进自由 JSON。

### 2.2 完整示例

```json
{
  "schema_version": 1,
  "modules": {
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
          "type": "record",
          "description": "键是稳定物品 ID",
          "value": {"type": "object", "properties": {
            "数量": {"type": "integer", "min": 0, "description": "持有数量"},
            "说明": {"type": "string", "description": "来源及状态"}
          }},
          "initial": {"灵石": {"数量": 3, "说明": "随身携带"}}
        }
      }
    }
  }
}
```

初始化运行值（注意没有 `modules`、`properties`、`type`、`initial` 包装）：

```json
{"世界":{"时间":"白天"},"清月":{"灵力":100,"心情":"平静","身体":{"伤势":null},"背包":{"灵石":{"数量":3,"说明":"随身携带"}}}}
```

### 2.3 世界卡、角色与开局的关系

- 世界卡**只在 `data.state` 声明一棵统一状态树**；不再运行时拼接 `world/user`，不隐式生成虚拟 `全局` 或选中角色的 `user` 状态。
- `characters[]` 仍负责角色设定、角色 ID 和可扮演许可。原有 `characters[].state` 属于**旧格式导入数据**；迁移时由导入器/作者显式映射到 `data.state.modules[目标根名称]`，处理重名与类型冲突，不能悄悄合并或只加载玩家角色的状态。选中的 `user` 只是 Session 的角色身份，并非状态根的特殊命名空间。
- Opening 的 `initial_state` 是与运行值同形的**部分对象覆盖**：沿固定 `object` 递归到已定义叶子；`record/array/json` 叶子只能整体替换，不能把对象初值误当成深合并。所有覆盖值由 Zod 完整验证；未知键、额外固定字段、类型错误阻止开局初始化。
- 创建 Session 时直接读取世界卡当前 `data_json` 的 State Schema，根据 `initial` 构建完整 S0，应用 Opening 初始覆盖后写入根 Assistant Entry 的 `payload.stateSnapshot`；**Session 不复制 Schema 或世界快照**。下一轮世界卡变更若使旧快照不兼容，允许舍弃旧值并以最新 Schema 的初值重建；既有故事消息仍保留。

## 3. 创作者 UI 与导入

默认编辑视图是一棵可展开的状态树；作者添加「字段/对象/字典/列表」，只需看**字段名、类型、默认值、描述**。数字范围、枚举项、可为空等在高级设置。对象内新增固定字段；字典配置 item 结构与初值映射；列表配置 item 结构与有序初值；预览区实时给出实际运行 JSON、完整路径及类型错误。

可从示例 JSON 生成建议定义，但空数组、空字典、null、数组混合类型均需作者确认；不能以猜测结果直接保存为可用定义。创建 Session/编辑状态时必须验证定义、所有初值、Opening 覆盖及编译后的 Schema；作者不用手写工具调用、路径枚举或更新操作。

## 4. 类型引擎和安全边界

- 服务端目标 Hono/TypeScript，使用 **Zod** 验证。受限定义 AST 是存储事实来源，直接编译出运行校验器；另编译为通用 JSON Schema/Provider strict 子集，不依赖 Zod 反向解析任意 JSON Schema。
- 用每次运行时从最新世界卡读取的 Schema 检查初始快照、每个操作参数及本轮最终完整快照；失败返回具体路径、期待类型、实际值和操作索引。JSON Schema 对 Provider 是减少错误的生成提示，不取代服务端 Zod 验证。
- 避免原型污染和路径混淆：以安全字典处理 `__proto__`、`constructor` 等键，严格检查 Pointer 转义与目标存在性；限制键名、深度、条目数、变更数与字节大小。拒绝未知固定字段与整个根/模块写入。
- 状态管理只保证结构约束与提交一致性；不会根据自然语言描述自动修正剧情、推断不确定的值，或调用额外隐形模型补状态。

## 5. 模型更新协议：ChangeSet

模型不直接生成任意 JSON Patch；统一内部协议是 `changes: StateChange[]`，**所有状态变更项必须有非空 reason 描述**，供状态栏解释变化。一轮变化按顺序作用于当前分支全量状态 S 的副本，全部通过后才能提交完整 S'。

| op | 参数 | 语义 |
| --- | --- | --- |
| `set` | `target, value` | 设置已声明的标量/可空/枚举或有容量限制的整块 `json/array` 叶子；不替换固定 object 根/分组或整个 record |
| `adjust` | `target, delta` | 对已声明 number/integer 做加减，计算后的值必须通过 min/max、整数校验；原值为 null 时拒绝 |
| `upsert` | `target, key, value` | 在已声明 record 中新增或替换一个稳定键；value 必须完整符合 record.value Schema |
| `set_record_field` | `target, key, field, value` | 更新已存在 record 成员的一个已声明固定子字段；field 是相对 JSON Pointer（如 `/数量`），不得跨 item |
| `remove` | `target, key` | 只删除 record 中已存在的动态键；不能删除固定字段 |
| `append` | `target, item` | 只向已声明数组末尾追加一个符合 items Schema 的完整元素 |

所有操作（set/adjust/upsert/set_record_field/remove/append）都必须带 `reason: string`，说明对应变化在叙事中的原因。`reason` 是模型的说明而不是程序可证明的事实；程序校验类型、非空字符串和目标状态约束。没有变化时使用 `changes: []`，不需要凭空编造说明。

`target` 为 RFC 6901 JSON Pointer，例如 `/清月/灵力`、`/清月/背包`。动态 `key` 单独传递，避免模型拼接大量未知下标路径；`field` 的候选字段从 record.value 定义生成，允许固定嵌套路径，不接受模型猜测新结构。`json` 逃生口仅支持整体 set。动态记录建议 `record`，会发生索引变动的背包或角色关系不建议用 array；首期不提供数组按索引删除/移动。

示例（假设回春丹事先在背包中且灵力不会超限）：

```json
{
  "narrative": "清月服下回春丹，灵力恢复十点。",
  "changes": [
    {"op": "adjust", "target": "/清月/灵力", "delta": 10, "reason": "服用回春丹，灵力恢复"},
    {"op": "remove", "target": "/清月/背包", "key": "回春丹", "reason": "回春丹已经服用"}
  ]
}
```

`[]` 表示模型**明确无变化**，不等于未返回状态更新。引擎须校验当前 record key 确实存在、最终数值仍满足类型和范围；任何一个操作失败，整个 ChangeSet 不提交部分结果。没有 `set/add/insert/delete/move` 的 MVU 兼容执行通道。

### 5.1 Tool Call 优先，但能力门槛必须实测

目标工具 `submit_turn` 接收 `{narrative: string, changes: StateChange[]}`，以**一次模型生成输出**承载叙事与增量状态。工具描述由 StateService 从**本轮已激活、允许写入的状态 Module（StateScope）** 动态编译，尽量为每个 op/target 生成类型受限的 JSON Schema 分支：例如 `/清月/灵力` 的 delta 必须是数字，`/清月/背包` upsert value 必须是具体 item object；`target` 优先固定枚举而非裸字符串。模型没有看到/未激活的 Module 默认不可写，仍始终存在于完整快照中。

动态 Schema 需要限制枚举目标数量、嵌套深度和总输入 Token。不同模型/Provider 对 `anyOf`、严格工具、复杂嵌套、工具参数流式支持不同，不能假设任何模型都能一次请求完成且无损逐字流式展示长叙事。底层调用尽量使用 Pi 内置实现，ProviderService 负责查询/校验模型能力而不是为各供应商重复写 Adapter。**只对实际模型 PoC 验证过的模型开启工具模式**；未验证时使用明确选定的内联模式或报不支持，不在生成中途静默切换协议。无论生成侧是否声称 strict，服务端始终执行完整验证。

### 5.2 内联回退

流式文本能力优先或 Provider 无法稳定调用结构化工具时，模型回复正文后仅允许**一个末尾** `<StateUpdate>`，其中为合法 JSON `{"changes":[...]}`，与 Tool Call 进入同一 ChangeSet 校验器：

```text
清月缓缓放下剑。

<StateUpdate>
{"changes":[{"op":"set","target":"/清月/心情","value":"放松","reason":"战斗结束后清月放松了下来"}]}
</StateUpdate>
```

严格拦截分段标签避免流式露出，块中不允许 Markdown 围栏或其他文本；原始输出与清洗后的正文分开存储，更新块不回注后续聊天历史。缺失块状态为 `missing`，重复、提前出现、未闭合、非法 JSON 或模型中断为 `invalid`，不解释成 `[]`。每轮只选择 tool/inline 之一，不重复执行；工具返回是否需要后续模型请求是 Provider/Pi 的待验证能力，协议不承诺零续轮。**重要**：`submit_turn` 的 `narrative` 可能仅存在于 Assistant 的 ToolCall 参数中；原始 Assistant ToolCall 和 ToolResult 仍须全部持久化。若本轮没有另行生成最终可见的 Assistant 叙事，则在状态校验成功后，将该 narrative 按原文写成一条 `origin=derived_tool_narrative` 的规范化 Assistant Entry；模型下轮历史只读取其叙事 text，不回放旧工具参数或 ToolResult，且已有独立 Assistant 正文时不能重复追加。

## 6. 加载、读取与模板

### 6.1 状态根与世界书的条件加载

状态根 `load` 默认 `{"mode":"always"}`，仅支持 `always` 与 `on_mention`；**不支持 manual**。关键词检测只扫描本次实际送模型的 user/assistant 叙事历史（经 WorldCard `none/window/summary` 策略处理）和当前 User 输入。`on_mention` 使用 `keywords`、`keyword_logic:any|all`、`exclude_keywords`，基础条件未命中则不加载。

若存在 `when`，它是附加的 **AND 条件**：`active = modeMatched && evaluateWhen(fullState)`。`always + when` 必须满足 when；`on_mention + when` 必须同时命中关键词且 when=true；排除词命中一票否决。`when` 对当前世界线最新**完整状态**求值，不能用筛选出来的局部状态代替全量 State。条件引擎由 [TextRenderer](text-rendering.md) 共享。

状态根激活后，其描述与当前值进入 `worldState` NodeBuilder，也用于构造受限状态更新 Tool Schema；未激活的根仍留在全量状态中，但不默认暴露给模型或允许更新。摘要、滑窗、工具消息过滤只改变关键词来源，**不改变完整状态的读取**。

状态栏根据全量状态展示字段，不取决于状态根是否加载进模型。世界书和状态根的匹配范围完全一致，不独立设置 Preset scan_depth。

### 6.2 文本读取

状态读取 `{{state:/清月/灵力}}` 与普通宏 `{{user}}` 均由独立共享的 [TextRenderer](text-rendering.md) 处理，AgentContext 只提供运行值。表达式 `get("/清月/灵力")`、`exists("/清月/身体/伤势")` 使用完整 RFC 6901 路径；null 是存在值，缺失与 null 不混淆。文本中的字符串原样插入，其余 JSON 类型使用紧凑 JSON，值仅展开一次，不再解释嵌套模板。缺失路径、非法转义提供来源定位诊断，不能默默创建字段。

```text
灵力：{{state:/清月/灵力}}
{{#if get("/清月/灵力") < 20}}
灵力不足，应结合剧情表现疲惫。
{{else}}
仍有余力。
{{/if}}
```

世界书正文、`load.when`、自定义 Prompt、状态 description 和未来状态栏使用独立 `domain/text` 的**同一个只读表达式解析器**，支持括号、有限数字/字符串/布尔/null、比较、算术及 `&& || !`、`if / else if / else`；无 JS/EJS、赋值、循环、网络/文件访问、动态执行或状态写入。仅布尔结果能作为 `when/if`；按标准类型严格比较，不做隐式强转。表达式对当前分支最新完整状态快照求值、短路求值，错误给出可定位诊断。AgentContext 先筛选条目，再让所有 NodeBuilder 完成原始消息组装，统一使用共享 TextRenderer 解析/转换一次；预览和执行使用同样的规则。

## 7. 状态结算、完整 Agent 消息和世界卡更新

1. 创建 Session 时只写 `world_id`，不保存世界快照。Opening 正文成为根 Assistant Entry，初始状态 S0 根据当前世界卡 Schema 和 `opening.initial_state` 构造，保存于该 Entry 的 `payload.stateSnapshot`。
2. 玩家输入是新的 User Message Entry；Assistant 生成可能有多个包含 `toolCall` 块的完整消息，并可能产生独立 `toolResult` Message Entry。**每条真实 Pi 消息都按原样持久化**，不可把工具消息仅留在内存或作为可选日志。
3. AgentContext 独立沿真实 parent_id 父链找到最近一个**有效、已完成 Assistant Entry** 的全量状态；Prompt 摘要/近 N 消息/工具过滤都不影响 State 的查询。
4. 模型输出叙事和 `StateChange[]`，每项 Change 强制 `reason`。StateEngine 在完整 S 副本上顺序应用并验证每个变更和最终新状态；工具返回不是已结算状态，失败时不将非法更改标记为成功。
5. 生成成功后，将完整 S' 和含 reason 的变更元数据写入最终 Assistant Message Entry（必要时为由终止型 ToolCall.narrative 规范化生成的 Assistant Entry）。`off` 模式继承 S；明确 `changes: []` 也保留完整状态。Chat UI/新模型历史只提取 user/assistant **叙事文本**，剔除 ToolCall/ToolResult、思维块及内联状态标记；但 Raw Entries 保留原始 ToolCall/ToolResult。
6. **世界卡只有最新一份，允许旧状态失效**：下一次使用新的 `worlds.data_json` 状态 Schema 读取历史 S。若结构不兼容，允许舍弃旧值并按最新 Schema 的 initial 重建一个完整初态，标记 `stateReset` 以便诊断。不要把旧 Schema 状态强行转换、导致旧 Session 无法继续；旧历史消息和它们当时保存的状态 JSON 仍保留。
7. 多分支从当前 tip 的真实父链取状态，不能从数据库全局最近 Entry 或另一个分支取值。对有后代的历史编辑/重新生成，不静默重写后代状态；可通过新分支保存新的输出。

SQLite `entries.payload` 记录 Pi Message 和完成 Assistant 的完整状态；`sessions` 只通过 `world_id/preset_id/user_character_id/tip_entry_id` 关联事实。**不建 run_tool_calls/runs/messages 独立表，不用 Session 世界快照或 selected_run_id。**

## 8. 验收与未解决问题

- 类型：初始化所有基础类型、null、嵌套对象、record/array、JSON 逃生口、错误初值、Opening 部分覆盖、min/max/enum、额外键拒绝。
- 更新：六种操作的路径白名单、record 新增/修改/删除、数组追加、数值区间、顺序、任何错误整组回滚，生成中断不部分提交。
- 一致性：消息级 Entry 的真实 parent_id 分叉、Assistant 重新生成/工具消息顺序、无变化也保存完整状态；本地 MVP 不引入复杂 revision 矩阵。
- TextRenderer：`{{state:/...}}`、`get/exists/if`、世界书 when、状态根 load、动态目标、世界卡预览和未来状态栏行为一致；模板绝不写状态。
- **Provider PoC 必须优先完成**：至少两类 Provider 的 strict Tool 支持、复杂 Schema 通过率、长篇 narrative 流式表现、内联失败率、输出正确率及输入/输出 Token、延迟和语义更新召回率。选择正式默认通道前必须量化，不能只看 JSON 合法率。
- **迁移清单**：旧 `characters[].state` 显式并入统一 `data.state`，旧 `world/user` 快照须明确转换，旧 MVU / RFC6902 更新协议不自动兼容；升级旧格式前检查当前世界卡、Opening、`entries.payload`，先备份再迁移；新 WorldCard Schema 可以使历史状态失效，而非强制全局迁移。

外部参考：[Zod JSON Schema](https://zod.dev/json-schema)、[JSON Schema](https://json-schema.org/)、[RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)、[RFC 6902](https://www.rfc-editor.org/rfc/rfc6902)、[OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)、[Anthropic Tool Use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)。
