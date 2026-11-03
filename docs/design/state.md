# 状态管理：强类型状态树、语义变更与完整快照

> 2026-11-03 目标设计，**尚未实现**。本文为 SillyRealms 状态唯一权威规范，替代旧的基于 `initial` 推断类型、`world/user` 运行值、MVU `<UpdateVariable>` 和模型直接提交 RFC 6902 JSON Patch 的方案。背景决策与测试计划见工作区 `plan/realms-typed-state-redesign-design.md` / `-tasks.md`。其中动态工具 Schema、长叙事 Tool Call 流式及 Provider 兼容性仍须 PoC，不能标称已验证。

## 1. 目标、取舍及术语

- **作者只负责业务含义**：使用可视化编辑器创建「名称、类型、初始值、描述」，可选设置数值上下限、枚举、可空和加载规则；作者不需要理解 Zod、Tool Schema、JSON Pointer 或更新操作。
- **单一类型定义**：发布世界卡中的 `data.state` 是受限、可序列化的定义 AST；编译器从同一 AST 分别生成 Zod 校验器、用于 Provider 的 JSON Schema 与运行时工具目标。不要把运行时 Zod 代码、EJS、任意 JS 直接存入世界卡，不依赖实验性 `z.fromJSONSchema` 作为关键反向转换。
- **Schema 约束的是数据形状**，`description` 约束剧情语义；类型正确不等于叙事、数值演变正确。严格拒绝违反显式类型/范围的状态值，不擅自把错误数字夹回范围。
- **写入不是通用 JSON Patch**：模型通过类型受限的 ChangeSet 描述少量变化，服务端执行并验证；可在诊断层导出差异 Patch，但 **RFC 6902 六操作不是模型协议**。JSON Pointer 只用于统一寻址，访问值与更新均遵循该路径。
- **全快照**：每一条已持久化 Entry 逻辑上对应一份完整运行状态 JSON，Snapshot 不含 `type`、`description`、`initial`、`load`、`global/entities/values` 包装。
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
- `object`、`record`、`array` 可以嵌套，嵌套深度、字段个数、JSON 字节和 Tool Schema 字节有实现侧上限，发布时报错而非截断。标识符为非空字符串，允许中文和点号；指针路径中 `~` 转义 `~0`、`/` 转义 `~1`。
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
- 创建 Session 时冻结 `state_definition_json` 和 `state_schema_hash`，按 `initial` 深拷贝构建快照并应用 Opening 覆盖。后续世界卡更新不会隐式重置既有快照或改变其结构；不兼容的 Schema 变更需要显式迁移或新建会话。

## 3. 创作者 UI 与导入

默认编辑视图是一棵可展开的状态树；作者添加「字段/对象/字典/列表」，只需看**字段名、类型、默认值、描述**。数字范围、枚举项、可为空等在高级设置。对象内新增固定字段；字典配置 item 结构与初值映射；列表配置 item 结构与有序初值；预览区实时给出实际运行 JSON、完整路径及类型错误。

可从示例 JSON 生成建议定义，但空数组、空字典、null、数组混合类型均需作者确认；不能以猜测结果静默发布。发布时必须验证定义、所有初值、Opening 覆盖及编译后的 Schema；作者不用手写工具调用、路径枚举或更新操作。

## 4. 类型引擎和安全边界

- 服务端目标 Hono/TypeScript，使用 **Zod** 验证。受限定义 AST 是存储事实来源，直接编译出运行校验器；另编译为通用 JSON Schema/Provider strict 子集，不依赖 Zod 反向解析任意 JSON Schema。
- 用同一冻结 Schema 检查创建时初始快照、每个操作参数及每轮最终完整快照；失败返回具体路径、期待类型、实际值和操作索引。JSON Schema 对 Provider 是减少错误的生成提示，不取代服务端 Zod 验证。
- 避免原型污染和路径混淆：以安全字典处理 `__proto__`、`constructor` 等键，严格检查 Pointer 转义与目标存在性；限制键名、深度、条目数、变更数与字节大小。拒绝未知固定字段与整个根/模块写入。
- 状态管理只保证结构约束与提交一致性；不会根据自然语言描述自动修正剧情、推断不确定的值，或调用额外隐形模型补状态。

## 5. 模型更新协议：ChangeSet

模型不直接生成任意 JSON Patch；统一内部协议是 `changes: StateChange[]`。一轮变化按顺序作用于冻结父快照 S 的副本，全部通过后才能提交完整 S'。

| op | 参数 | 语义 |
| --- | --- | --- |
| `set` | `target, value` | 设置已声明的标量/可空/枚举或有容量限制的整块 `json/array` 叶子；不替换固定 object 根/分组或整个 record |
| `adjust` | `target, delta` | 对已声明 number/integer 做加减，计算后的值必须通过 min/max、整数校验；原值为 null 时拒绝 |
| `upsert` | `target, key, value` | 在已声明 record 中新增或替换一个稳定键；value 必须完整符合 record.value Schema |
| `set_record_field` | `target, key, field, value` | 更新已存在 record 成员的一个已声明固定子字段；field 是相对 JSON Pointer（如 `/数量`），不得跨 item |
| `remove` | `target, key` | 只删除 record 中已存在的动态键；不能删除固定字段 |
| `append` | `target, item` | 只向已声明数组末尾追加一个符合 items Schema 的完整元素 |

`target` 为 RFC 6901 JSON Pointer，例如 `/清月/灵力`、`/清月/背包`。动态 `key` 单独传递，避免模型拼接大量未知下标路径；`field` 的候选字段从 record.value 定义生成，允许固定嵌套路径，不接受模型猜测新结构。`json` 逃生口仅支持整体 set。动态记录建议 `record`，会发生索引变动的背包或角色关系不建议用 array；首期不提供数组按索引删除/移动。

示例（假设回春丹事先在背包中且灵力不会超限）：

```json
{
  "narrative": "清月服下回春丹，灵力恢复十点。",
  "changes": [
    {"op": "adjust", "target": "/清月/灵力", "delta": 10},
    {"op": "remove", "target": "/清月/背包", "key": "回春丹"}
  ]
}
```

`[]` 表示模型**明确无变化**，不等于未返回状态更新。引擎须校验当前 record key 确实存在、最终数值仍满足类型和范围；任何一个操作失败，整个 ChangeSet 不提交部分结果。没有 `set/add/insert/delete/move` 的 MVU 兼容执行通道。

### 5.1 Tool Call 优先，但能力门槛必须实测

目标工具 `submit_turn` 接收 `{narrative: string, changes: StateChange[]}`，以**一次模型生成输出**承载叙事与增量状态。工具描述从**本轮已激活、允许写入的状态 Module** 动态编译，尽量为每个 op/target 生成类型受限的 JSON Schema 分支：例如 `/清月/灵力` 的 delta 必须是数字，`/清月/背包` upsert value 必须是具体 item object；`target` 优先固定枚举而非裸字符串。模型没有看到/未激活的 Module 默认不可写，仍始终存在于完整快照中。

动态 Schema 需要限制枚举目标数量、嵌套深度和总输入 Token。不同 Provider 对 `anyOf`、严格工具、复杂嵌套、工具参数流式支持不同，不能假设任何 Provider 都能一次请求完成且无损逐字流式展示长叙事。**仅在实际 Provider PoC 验证后设为该连接默认**；不存在已验证支持时使用内联兼容通道。无论生成侧是否声称 strict，服务端始终执行完整验证。

### 5.2 内联回退

流式文本能力优先或 Provider 无法稳定调用结构化工具时，模型回复正文后仅允许**一个末尾** `<StateUpdate>`，其中为合法 JSON `{"changes":[...]}`，与 Tool Call 进入同一 ChangeSet 校验器：

```text
清月缓缓放下剑。

<StateUpdate>
{"changes":[{"op":"set","target":"/清月/心情","value":"放松"}]}
</StateUpdate>
```

严格拦截分段标签避免流式露出，块中不允许 Markdown 围栏或其他文本；原始输出与清洗后的正文分开存储，更新块不回注后续聊天历史。缺失块状态为 `missing`，重复、提前出现、未闭合、非法 JSON 或模型中断为 `invalid`，不解释成 `[]`。每轮只选择 tool/inline 之一，不重复执行；工具返回是否需要后续模型请求是 Provider/Pi 的待验证能力，协议不承诺零续轮。

## 6. 加载、读取与模板

### 6.1 根 Module 加载

根 `load` 默认 `{"mode":"always"}`，支持 `always` 与 `on_mention`；`on_mention` 使用 `keywords`、`keyword_logic:any|all`、`exclude_keywords`，两者都可有受限布尔 `when`。扫描使用当前 User 和最近三个真实祖先正文（预设可配置深度）；`when` 在**同一冻结父快照**上求值。激活 Module 的当前值、路径、类型、描述一起进入 `worldState` 节点和动态写入目标；未激活根保留在快照但默认不向模型暴露、不可写。超出必需状态/工具预算则拒绝生成或显式要求收窄激活，不静默截断 schema 和变更约束。

世界书保留 `always/on_mention/manual`，新增可选 `exclude_keywords` 与 `when`；正文和 description 可以读取状态而不能修改它。加载和状态面板显示无关；面板根据完整有效快照显示当前活动叶子所有字段。

### 6.2 文本读取

统一状态读取 `{{state:/清月/灵力}}`；普通宏如 `{{user}}` 由 Context 单独处理。表达式 `get("/清月/灵力")`、`exists("/清月/身体/伤势")` 使用完整 RFC 6901 路径；null 是存在值，缺失与 null 不混淆。文本中的字符串原样插入，其余 JSON 类型使用紧凑 JSON，值仅展开一次，不再解释嵌套模板。缺失路径、非法转义提供来源定位诊断，不能默默创建字段。

```text
灵力：{{state:/清月/灵力}}
{{#if get("/清月/灵力") < 20}}
灵力不足，应结合剧情表现疲惫。
{{else}}
仍有余力。
{{/if}}
```

世界书正文、`load.when`、自定义 Prompt、状态 description 使用**同一个只读表达式解析器**，支持括号、有限数字/字符串/布尔/null、比较、算术及 `&& || !`、`if / else if / else`；无 JS/EJS、赋值、循环、网络/文件访问、动态执行或状态写入。仅布尔结果能作为 `when/if`；按标准类型严格比较，不做隐式强转。表达式对同一父快照求值、短路求值，错误给出可定位诊断。所有加载/模板结果在 Context 预算前解析并统一计量；预览和执行同一逻辑。

## 7. Entry 生命周期、存储与冲突

1. 创建 Session 时冻结已发布世界卡的状态定义和 hash；Opening initial_state 递归覆盖被声明的固定叶子、动态集合整值替换，整体 Zod 校验后在根 Entry 保存初始化完整快照。
2. User Entry 继承其父完整有效快照。用户输入的愿望并不直接结算为已发生事实。
3. AI 一轮基于固定父 Entry、父状态 revision、Schema hash 和已激活模块构建上下文与 Tool Schema，流式生成 narrative + changes。
4. 服务端检查 JSON 与目标白名单、操作适用性、动态键、Schema 类型和上限；在父状态副本顺序应用所有变更，整份最终快照 Zod 验证成功才允许写入。
5. 短 SQLite 事务中检查生成 ID 幂等、活动叶子、父 Entry、父状态修订及 Schema hash，原子保存清洗正文、原文（限制访问）、ChangeSet、结果状态和**完整**新快照；不得跨世界线写回或双扣 `adjust`。
6. `success` 表示合法结算（包括 `changes:[]`），`inherited` 表示 User 复制，`missing` 表示缺失必需更新，`invalid` 表示失败，`stale` 表示历史修订/定义冲突后失效。失败可保留正文及父快照供诊断，但**不得作为已结算快照继续生成**；用户需显式重试、修复或确认继承状态并记录决定。
7. AI 生成中断/取消不提交不完整 AI Entry；保留已完成 User 叶子供重试。分叉只继承各自父 Entry；重新生成重新从正确父版本结算；编辑旧正文使受影响的自己及后代状态 stale，不自动重写历史或重放操作。

SQLite 以 `sessions.state_definition_json / state_schema_hash` 和 `entries.state_snapshot_json / state_changes_json / state_status / state_schema_hash / state_revision / parent_state_revision / generation_id` 为建议逻辑字段。压缩/去重允许，但按任意已提交 Entry 必须能得到完整逻辑快照；不把模型 SDK 的对话 JSONL 当成第二权威源。Schema 迁移显式确认并留备份，不把新卡定义直接套到旧 Entry 的值。

## 8. 验收与未解决问题

- 类型：初始化所有基础类型、null、嵌套对象、record/array、JSON 逃生口、错误初值、Opening 部分覆盖、min/max/enum、额外键拒绝。
- 更新：六种操作的路径白名单、record 新增/修改/删除、数组追加、数值区间、顺序、任何错误整组回滚，生成中断不部分提交。
- 一致性：重复 generation_id、版本冲突、再生、分叉、历史编辑 stale、无变化也存完整逻辑快照。
- Context：`{{state:/...}}`、`get/exists/if`、世界书 when、状态根 load、动态目标、预算、预览和执行一致；模板绝不写状态。
- **Provider PoC 必须优先完成**：至少两类 Provider 的 strict Tool 支持、复杂 Schema 通过率、长篇 narrative 流式表现、内联失败率、输出正确率及输入/输出 Token、延迟和语义更新召回率。选择正式默认通道前必须量化，不能只看 JSON 合法率。
- **迁移清单**：旧 `characters[].state` 显式并入统一 `data.state`，旧 `world/user` 快照须明确转换，旧 MVU / RFC6902 更新协议不自动兼容；新 Schema 生效前检查既有世界卡、Opening、历史 Entry，先备份再迁移。

外部参考：[Zod JSON Schema](https://zod.dev/json-schema)、[JSON Schema](https://json-schema.org/)、[RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)、[RFC 6902](https://www.rfc-editor.org/rfc/rfc6902)、[OpenAI Structured Outputs](https://platform.openai.com/docs/guides/structured-outputs)、[Anthropic Tool Use](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview)。
