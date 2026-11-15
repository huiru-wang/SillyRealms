# SR 预设分列与节点驱动后置处理方案 v7

日期：2026-11-15。状态：设计，未实施。配套 [实施任务](./sr-preset-node-processing-v7-tasks.md)。

本文以最新用户要求为准，取代 v6 的五列预设存储、独立 output_plugins 开关、七系统节点以及独立 output_prompts/引用模型。v6 的简化提示内容、后置位置、裸输出标签、权限/失败规则和旧历史兼容设计继续适用；可参考 [v6 提示与解析设计](./sr-output-plugins-prompts-v6.md)，冲突时以本文为准。

本轮只保存方案，不修改源码、数据库、正式 docs 或 AGENTS，不执行迁移或真实模型调用。

## 1. 产品行为

预设基础设置包括名称、描述、模型参数和上下文策略；节点列表定义发送给模型的内容。

默认顺序：main、用户信息、角色信息、世界书、会话历史、用户输入、世界状态、行动建议。前六项为固定系统节点；最后两项为内置输出节点，默认开启，可在节点行切换。用节点类型区分它们，不能再把世界状态称作另有开关的系统能力。

- 开启世界状态节点：注入完整 `<世界状态>` 提示，并启用服务端 state_update 后置处理。
- 开启行动建议节点：注入完整 `<行动建议>` 提示，并启用服务端 action_suggestions 后置处理。
- 关闭节点：既不注入该节点提示，也不执行对应输出业务处理。
- 不再存在独立 output_plugins、能力面板开关或 prompt_ref。节点自身是提示和启用状态的唯一来源。
- 固定相对顺序保持用户输入、世界状态、行动建议；一次请求中每个输出节点只展开一次。
- 模型依然直接输出 state_update、action_suggestions，不要求 sr_extensions。

## 2. presets 八列

| 列 | SQLite 类型/约束 | 内容 |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | 预设 ID，迁移保留 |
| name | TEXT NOT NULL UNIQUE | 名称 |
| description | TEXT，可空 | 描述；保留旧空字符串与缺省的区别 |
| model_parameters | TEXT NOT NULL，合法 JSON 对象 | 原 model_parameters，例如 temperature |
| context_strategy | TEXT NOT NULL，合法 JSON 对象 | 原 budget 完整对象，不只是 strategy 名称 |
| config_json | TEXT NOT NULL，合法 JSON 对象 | 节点配置及其格式版本 |
| created_at | INTEGER NOT NULL | 创建时间，毫秒时间戳 |
| updated_at | INTEGER NOT NULL | 更新时间，毫秒时间戳 |

model_parameters 示例：

```json
{"temperature":1}
```

context_strategy 示例：

```json
{
  "strategy":"rolling_summary",
  "max_context_tokens":32768,
  "max_output_tokens":2048
}
```

字段名 context_strategy 不恢复历史字符串层级用法。原预算边界、兼容转换、100% 触发/60% 目标、一次完整摘要和连续历史后缀策略保持不变。

数据库保存 JSON 文本；API 读取后将这三列解码为对象，写入时验证后序列化。JSON 中不重复保存 name/description/model_parameters/budget，避免两份数据相互覆盖。tags、模型凭据、会话引用仍按原表关系处理。

## 3. config_json 只组织节点

顶层为 `{"schemaVersion":2,"nodes":[...]}`；2 是拟议预设格式版本，不是数据库版本。schemaVersion 用于解释节点结构及选择输出协议，不新增自由配置的解析器。

节点类型建议：

| kind | 用途 | 启用规则 |
| --- | --- | --- |
| system | main/personaInfo/characterInfo/worldInfo/chatHistory/userInput 六个固定节点 | 必须存在且启用；角色/固定来源受 schema 限制 |
| output | worldState/actionSuggestions 两个内置输出节点 | 默认存在且 enabled=true；可开关 |
| text | 原有自定义提示 | 保留既有编辑能力，不能冒充 output ID 或获得处理权限 |

两个 output 节点用 enabled 作为唯一启用字段；不再同时放 load.mode/when、provides、能力覆盖开关或配置表达式以决定是否生效。世界卡角色/世界书/状态的 load 行为不变；其他类型节点原有加载功能不因本次输出节点简化而扩大。

节点的完整提示存于自身 `prompt`；可使用有序 parts 将静态 text 与固定 source 插槽拼接。这是声明式材料绑定，不向预设开放 getState、脚本或任意循环。下面仅展示两个 output 节点的结构片段；世界状态的更新说明为缩短文案，实施种子应采用已审阅的完整 v6 提示。

```json
{
  "schemaVersion":2,
  "nodes":[
    {
      "id":"worldState",
      "name":"世界状态",
      "kind":"output",
      "role":"system",
      "enabled":true,
      "prompt":{
        "parts":[
          {"text":"<世界状态>\n当前状态：\n"},
          {"source":"state.currentValues"},
          {"text":"\n状态更新规则：\n"},
          {"source":"state.updateRules"},
          {"text":"\n先完成叙事正文，再根据实际发生的事件提交状态变化。遵守各项 description、type、min/max。path 使用给定状态 key，value 为完整新值，可选 reason。没有变化时输出空数组。\n输出格式：\n<state_update>[]</state_update>\n</世界状态>"}
        ],
        "empty":"<世界状态>\n当前状态：无。\n状态更新规则：无。\n本轮无需输出 state_update。\n</世界状态>"
      }
    },
    {
      "id":"actionSuggestions",
      "name":"行动建议",
      "kind":"output",
      "role":"system",
      "enabled":true,
      "prompt":{
        "parts":[
          {"text":"<行动建议>\n行动建议是提供给玩家选择的下一步行动。根据正文结束后的情境，依次给出缓慢、中速、快速推进叙事的三个建议。\n建议具体、简短，不预先保证结果，每条不超过50个字符，不附速度标签或解释。\n正文之后输出完整的 action_suggestions，内容为三个字符串的 JSON 数组；存在 state_update 时放在其后。实际输出不使用代码围栏，也不添加外层包裹标签。\n</行动建议>"}
        ]
      }
    }
  ]
}
```

公共输出格式与完整示例也归属于节点配置，例如 output 节点自身的 `prompt.outputFormat` 和 `prompt.example`；分别使用完整、状态单独或建议单独分支，规则内不要求关闭节点的标签。通过固定组合选分支，不再引入第二份顶层 output_prompts。两个节点都关闭时不注入输出格式。

旧 summary_prompt 移入 chatHistory 节点的 `summary.prompt`，摘要执行时读取该用途配置；不会将摘要生成指令混进主叙事请求。Agent/诊断文案继续隔离，并归档到相关节点的用途子配置中，例如 main 的用途提示与 worldState 的 Agent 工具描述；它们不因 Direct 节点后置处理而变成 Direct 工具循环。

## 4. 开启节点即开启对应处理策略

Server 固定注册以下绑定，不在预设中存 handler 名称、模块路径或脚本：

| 受保护节点身份 | 注入的完整提示 | 启用的后置处理 |
| --- | --- | --- |
| kind=output, id=worldState | `<世界状态>…</世界状态>` | 解析 state_update；验证 path/value/权限并处理状态候选 |
| kind=output, id=actionSuggestions | `<行动建议>…</行动建议>` | 解析 action_suggestions；验证三个不同字符串及各自1–50码点，再提供给前端 |

只根据已验证的 kind/id 与 enabled 取策略，不能按显示名称或提示文本猜测。保留 ID 禁止普通 text 节点使用，重复 ID、错 kind、非法 role 直接拒绝。

准备 Run 时一次性冻结各列和节点。选出启用节点后，从同一结果同时生成提示与后置处理集合，确保不存在“提示已关、处理仍开”或反向不一致。旧会话 capability_overrides 不再覆盖新格式节点 enabled；只保留兼容备份并显示迁移说明，旧格式行为独立处理。

世界状态节点开启但本轮没有激活可写根：处理策略仍是 enabled，但状态结果为 not_required，使用节点内 empty 提示，不要求 state_update。这与节点关闭不同。

两个 output 节点默认各一份完整 prompt；实时状态不持久化进预设。global/session 背景继续由对应背景节点提供，且不作为可写根。只有获准更新的状态进入世界状态的当前值和规则列表。

后置处理仍等 Provider 正常结束、完整块序列校验成功后进行。结构性错误不提交，状态部分失败阻止建议，建议局部失败不丢合法状态，取消/stop 不提交，均按 v6 的失败矩阵执行。关闭节点的保留标签可被共享切分器识别和隐藏，但不执行对应业务解码和处理。

## 5. 八列迁移与消费者

当前 presets 实际只有 id/name/config_json/created_at/updated_at 五列。本次新增三列，并将旧 JSON 中的 description、model_parameters、budget 分别迁入对应列。config_json 重组为节点配置；summary_prompt 与原能力提示物化进对应节点，删除独立 output_plugins/output_prompts 活跃配置。

升级前完整备份；事务转换；保留 id、名称、时间和世界/会话/应用默认引用。旧非法数据必须给出定位错误并回滚，不能静默填入新默认覆盖用户值。未知旧字段和原始 JSON 留在升级备份/迁移报告，不作为新运行时的第二配置来源。不要为了列展示顺序破坏外键或重建关联数据。

实际兼容性检查覆盖：

- routes/presets.ts 的创建、读取、PATCH、复制、导入、导出及旧 JSON 正规化逻辑。
- domain/tags.ts 的预设列表，目前从 config_json 提取 description，改读独立列。
- runtime/config.ts、persistence/run-store.ts 的配置读取、摘要提示、预算、模型参数和生效能力。
- routes/sessions.ts 与会话设置中旧能力来源/覆盖的计算，不允许继续控制新输出节点。
- Studio PresetStore/types/adapter 与新建、保存和导出形状，保留失败草稿与未编辑字段。
- 数据库种子、迁移测试、API/SDK 结果合同和旧协议历史读取。

对外 API 建议对应八列逻辑字段组织；JSON 列解码为对象，旧 budget 只允许在旧格式导入转换时出现，不长期维护双写别名。列更新与 config_json 更新在一个事务中完成，防止只保存部分预设。

运行时 presetHash 必须涵盖 model_parameters、context_strategy 和节点配置等全部执行相关字段，不能继续只哈希 config_json。预算估算和 final payload 使用同一冻结对象；第一次 await 后的编辑仅影响下一轮。

既有输入配额、preparation journal、临时状态与持久化边界、旧 sr_extensions/v1 历史读取和新 sr-output-blocks/v1 结果兼容继续保持。数据库升级版本按实施时版本递增，不复用世界组件 v5。

## 6. 验收与本轮自检

重点验证八列读写与 round-trip、列/JSON 不重复、迁移事务和引用完整；六个系统节点与两个 output 节点的身份/顺序；四种启用组合的提示和后置处理一致；无可写根的 not_required；实际 Provider payload 和同轮冻结；建议三条/50码点、旧历史恢复和全部结构失败边界。

本轮只进行源码消费者核查、设计一致性复核与文档示例 JSON 检查。未运行应用测试、浏览器或真实数据库升级。前述 v6 保留用于提示全文和解析说明，后续实施须同时读取本文，以免重新引入独立能力开关。
