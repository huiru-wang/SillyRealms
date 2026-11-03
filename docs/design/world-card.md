# 世界卡：内容定义、发布与实例同步

> 状态：领域设计，2026-11-03；强类型状态协议已同步，**尚未实现**。返回[文档索引](../README.md)，相关领域见[AgentContext](agent-context.md)、[会话](session.md)。

## 定位和内容归属

世界卡定义可重用的世界背景展示信息、独立角色、开局、**单个世界书**、可选状态字段及资源规则。**世界卡只负责内容与加载条件**；Preset 控制 Prompt 节点主顺序、角色和启停；世界书条目仅可选择预设允许的相对锚点及同锚点顺序，不得独立声明消息角色。命中条目与对应基础节点本体合并为一条 Prompt，角色继承目标节点，详见[Preset](preset.md)。

`data.description` 可以是 HTML 等展示内容，不自动进入 Prompt。故事前提、地点、事件、场景规则与示例等需供模型使用的信息属于 `data.lorebook.entries[]`；本期没有独立的 `scenes[]` 或 `examples` Prompt 插槽。角色的人物设定仍直接放在 `characters[]` 下。

用户扮演的 `user` **只能来自本世界卡 `characters[]` 中被允许的角色**；不支持外部个人身份或自由身份。世界卡保存静态定义，Session 保存本局用户角色快照、强类型状态定义和 Run 树；运行状态快照属于各 Run。

## 发布版本与同步

- 内容发布版本使用 `data.version = "X.Y"`（两段非负整数）。首次发布 `0.1`，例如 `0.1 → 0.2 → 1.0 → 1.1`；新版本按数值元组比较，必须严格递增，不以字符串排序。草稿可未发布，编辑草稿不会提升已发布版本。
- 格式版本 `spec_version` 与内容版本相互独立。仅保留世界卡的**当前草稿**和**最新发布内容**，不维护可浏览的每次历史发布副本。
- 创建世界实例时复制完整已发布 JSON 及其来源版本；新版本发布不会自动改动已有实例。用户查看可更新提示后可以手动同步。
- **手动同步只覆盖实例中的完整世界 JSON 快照与来源版本**，不做逐字段合并，也不触碰消息、分叉、记忆和已有 Run 状态快照。该实例所有分支下一次生成使用更新后的**非状态内容**；Session 已冻结的 `state_definition_json` / `state_schema_hash` 仍为当前状态权威，不因世界卡同步而直接替换；如要采用新卡状态定义必须显式进行兼容验证与迁移。还需检查旧设定的派生摘要、开局覆盖和角色身份映射兼容性；WorldInstanceContext 下一次调用直接从更新后的 Session 快照读取，不维护独立缓存失效系统。已存 Session 的 `user_character_id` 和选中角色快照不得自动更换；若新卡删除该角色、关闭其可扮演许可或更改状态定义，必须提示兼容冲突并阻止无声同步。**不会重新执行 Opening 初始化或重置已有世界线状态**；状态字段删除、改名、类型变化等不兼容更新必须明确处理迁移，不能隐式套用新规则。
- 实例如果未来需要临时修改世界设定，应以独立的本局覆盖配置表达，不回写到原世界快照内。存储字段见[存储设计](../technical/storage.md)。

## 内容结构与导入边界

```text
WorldCard
├─ spec / spec_version
└─ data
   ├─ name / summary / description / version / tags / cover
   ├─ characters[]           独立角色及其加载配置
   ├─ openings[]             多个开局及可选世界状态初值覆盖
   ├─ state                  可选强类型状态树（schema_version + modules）
   ├─ lorebook               单个世界书：entries[] 及各自 load
   ├─ regex_scripts[]        来源规则/可选扩展（MVP 不执行）
   ├─ assets[]               资源清单
   └─ extensions             非执行扩展/来源归档
```

结构外壳使用 `spec: "world_card"`、`spec_version: "0.1"`；`spec_version` 是格式版本，`data.version` 为两段递增的内容发布版本。有效卡需名称、至少一个有效 Opening 及可选玩家角色；草稿可以尚未完整。未知来源字段可归档保留，但不能未经支持就生效。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `name` | string，必填 | 世界卡名称 |
| `summary` | string | 列表简介，不发送模型 |
| `description` | string 或 `{format,content}` | 展示用说明，不自动发送模型 |
| `creator` / `creator_notes` | string | 作者与说明，不发送模型 |
| `version` | string | `X.Y` 内容发布版本 |
| `tags` | string[] | 搜索与分类 |
| `cover` | string | 可选 `asset:<ID>` 封面引用 |
| `characters[]` | array | 角色定义、可扮演许可及加载条件 |
| `openings[]` | array | 故事开局 |
| `lorebook` | object | 单个世界书，`entries[]` 存独立资料 |
| `state` | object，可选 | 唯一强类型状态定义 `schema_version + modules`；实例中的运行值不回写世界卡 |
| `extensions` | object | 不自动解释或执行 |

## 独立角色

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | string，必填 | 卡内稳定标识 |
| `name` | string，必填 | 角色名称 |
| `description` | string | 完整人物设定，包括需要时的性格、经历、外貌和关系 |
| `avatar` | string | 可选头像资源引用 |
| `tags` | string[] | 可选标签，用于展示、筛选和整理；缺省为空列表 |
| `load` | object，见「世界书与角色加载条件」 | 角色资料何时进入 `characterInfo` |
| `player_selectable` | boolean，默认 `false` | 世界卡级别的角色可扮演许可；仅 `true` 的角色能作为 `user` |
| `state` | 旧导入字段，不在新原生卡启用 | 旧角色状态须显式映射进入 `data.state.modules`；所有角色状态统一管理，不仅限玩家角色 |

角色与世界书条目使用相同的基础加载条件，见下文「世界书与角色加载条件」。玩家在本局选中角色时，默认提供该角色资料；其他角色按其加载配置筛选，并最终填入预设的 `characterInfo` 插槽。

角色设定直接放在 `description`，不要求通过世界书关联。新原生卡的角色动态状态统一在 `data.state.modules[角色状态根名]` 声明，`characters[].state` 不再作为生效定义；导入旧角色状态时须显式映射并检查重名。**实际变化的快照不写回世界卡**；角色的控制者和是否登场也不写在世界卡。`player_selectable=true` 只表示该角色**可以**被选为 `user`，不是每局自动被玩家控制；选择时会将该世界卡角色完整定义复制到 Session。

## 开局

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | string，必填 | 卡内稳定标识 |
| `name` | string，必填 | 选择开局时显示的名称 |
| `content` | string，必填 | 初始故事内容或特殊入口标记 |
| `player_characters` | string[]，可选 | 该 Opening 允许作为 `user` 的世界卡角色 ID 子集；不支持 `custom` 或外部身份 |
| `initial_state` | object，可选 | 与运行快照同形的部分覆盖，根键对应 `data.state.modules`；固定 object 递归覆盖，record/array/json 叶子整值替换并接受强类型校验 |

**可选角色 = 世界卡中 `player_selectable=true` 的角色 ∩ Opening 的 `player_characters`（如果提供）**。没有 `player_characters` 时默认使用世界卡全部可选角色；提供该字段时，所有 ID 都必须存在于本卡 `characters[]` 且满足 `player_selectable=true`，不能用 Opening 把不可扮演角色重新开放。空数组、未知 ID、重复 ID、禁用角色引用及 `custom` 等特殊标记都视为发布/创建校验错误。世界卡发布时至少有一名可扮演角色，每个有效 Opening 至少允许一名角色；草稿可以暂不完整。创建 Session 必须由用户从最终允许名单中**明确选定一个** `user`，并保存角色快照；MVP 不提供无角色参与、个人身份库或默认 `char`。

默认建议选择第一项；所选开局写入会话初始历史，后续生成不重复注入。创建实例时从 `data.state.modules` 递归产生完整默认运行值，叠加 `opening.initial_state` 中的**部分覆盖**并通过 Zod 全量校验后写入根 Opening Run。固定 object 沿已声明的子字段递归覆盖，record/array/json 作为一个完整叶子替换，不深合并记录成员。未知路径、额外固定键或类型错误阻止发布/初始化。初始状态仅在 Session 创建时构造一次，切分支和同步卡片不会重新初始化；详见[状态](state.md)。

## 强类型状态定义 `data.state`

状态是可选的独立插件，不替代叙事和世界书；此处只约定**世界卡存什么**，具体类型校验、Tool ChangeSet 和 Run 全量快照统一由[状态规范](state.md)规定。

原生格式固定为 `{"schema_version":1,"modules":{...}}`，`modules` 每个根为 `type:"object"` 的类型树，根可以是 `世界`、某位角色、地点或组织，根名就是快照顶层键。角色状态不再拆为单独的 `characters[].state` 或仅保存 `user`，作者在同一棵树里声明所有需要跟踪的实体。每个根可以有自己的 `load` 规则，内层状态不能设置 `load`。

支持 `string`、`number`、`integer`、`boolean`、`enum`、`object`、`record`、`array`、`json`。固定 `object` 用 `properties` 定义可嵌套字段，`record` 用 `value` 定义动态键值的强类型结构，`array` 用 `items` 定义元素类型，`json` 是只能整值更新的弱类型逃生口；不从 `initial` 推断类型。普通作者在编辑器中只需填写**字段名/类型/初值/描述**，枚举、数值范围和 nullable 属于可选高级设置。每个已声明固定叶子都有初值，object 由其子字段初值递归生成；record 的每个 item 需符合 value Schema。

例子（省略无关世界卡字段）：

```json
{
  "state": {
    "schema_version": 1,
    "modules": {
      "世界": {"type": "object", "load": {"mode": "always"}, "properties": {
        "当前时段": {"type": "enum", "values": ["白天", "夜晚"], "initial": "白天", "description": "剧情确实推进时更新"}
      }},
      "清月": {"type": "object", "load": {"mode": "on_mention", "keywords": ["清月"]}, "properties": {
        "灵力": {"type": "integer", "min": 0, "max": 100, "initial": 100, "description": "施法消耗，休息恢复"},
        "背包": {"type": "record", "description": "键是物品 ID", "value": {"type": "object", "properties": {
          "数量": {"type": "integer", "min": 0}, "说明": {"type": "string"}
        }}, "initial": {"灵石": {"数量": 3, "说明": "随身"}}}
      }}
    }
  },
  "openings": [{
    "id": "night", "name": "夜行", "content": "夜幕降临。",
    "initial_state": {"世界": {"当前时段": "夜晚"}}
  }]
}
```

`initial_state` 不包含任何 schema/description，不允许改变定义结构。Opening 局部覆盖只作用于声明的固定叶子，record/array/json 只做整值替换；统一编译的 Zod 先验证覆盖，再校验最终完整初始状态。旧 `{"当前时段": {"initial": ...}}`、独立角色 `state` 和旧 Opening 顶层字段均为**待迁移格式**，不对新格式偷偷做运行时兼容。

Agent 的六类受限操作为 `set/adjust/upsert/set_record_field/remove/append`，由引擎按当前类型和已加载根自动开放，作者不配置更新命令。Tool Call 优先但依赖真实 Provider 验证，内联 `<StateUpdate>{"changes":[...]}</StateUpdate>` 是回退格式，详见[状态](state.md)。**JSON Patch / MVU 命令不再是模型输入契约。**

`load.when`、世界书条件和文本引用可用冻结状态快照读取；在世界书正文/Prompt 中写 `{{state:/清月/灵力}}`，条件写 `get("/清月/灵力") < 20`。状态值和描述不能直接在卡片中执行 JS。

## 世界书与角色加载条件

一张原生世界卡拥有一个 `data.lorebook`，其中 `entries[]` 保存多个资料条目。`id` 在本世界书内部唯一，`title` 为显示标题，`content` 为模型可用正文。人物设定保存在角色定义中；地点、场景、组织、物品、历史事件、剧情规则和对话示例都可作为世界书条目。独立场景/示例来源内容可以归档，但 MVP 不隐式创建独立 Prompt 节点。

### 内容激活规则

角色 `load` 与世界书条目 `load` 都支持：

| 字段 | 类型 / 默认 | 作用 |
| --- | --- | --- |
| `mode` | `always/on_mention/manual`，默认 `manual` | 常驻、关键词、手动加载 |
| `keywords` | string[] / `[]` | `on_mention` 触发词 |
| `keyword_logic` | `any/all` / `any` | 多关键词满足任一或全部 |
| `exclude_keywords` | string[] / `[]` | 仅对 `on_mention` 排除任意命中项 |
| `when` | string，可选 | 受限只读布尔表达式，在冻结父状态上求值；对所有 mode 生效 |
| `order` | integer / `0` | **仅世界书**同一锚点同一侧排序，非预算优先级 |

世界书条目额外配置：

| 字段 | 允许值 | 用途 |
| --- | --- | --- |
| `anchor` | `personaInfo` / `characterInfo` / `worldState` / `userInput` | 目标基础节点，默认 `characterInfo` |
| `position` | `before` / `after` | 目标节点前/后，默认 `after` |

**世界书不支持 `role` 字段。** 所有激活条目与目标节点本体合并为**一条** Prompt，继承该节点配置的角色；`userInput` 固定继承 `user`。不能为条目设置 `system/user/assistant`，也不能修改预设节点主顺序、历史深度或任意自定义节点。

```json
{
  "lorebook": {
    "name": "世界设定",
    "entries": [
      {
        "id": "gate-rule",
        "title": "王宫通行规则",
        "content": "守卫需要核验通行证。清月灵力：{{state:/清月/灵力}}。",
        "load": {
          "mode": "on_mention",
          "keywords": ["王宫", "守卫"],
          "keyword_logic": "any",
          "anchor": "characterInfo",
          "position": "before",
          "order": 0
        }
      }
    ]
  }
}
```

角色的 `load` 不接受 `anchor/position/role`，其资料进入 `characterInfo` 基础节点，按原始角色数组顺序稳定排列；当前选为玩家的角色固定由 `personaInfo` 读取，不在 `characterInfo` 重复出现。世界书按 `(anchor,position,order,原始列表位置)` 稳定编排；同一条目在同一次构建中去重。`mode=always` 也受本局资料禁用策略影响，但即便节点本体被关闭，该节点锚点仍能生成合并后的消息；具体见[Preset](preset.md)。

Context 扫描默认本次 Run 的 User 文本及最近三个祖先 Run 的可见消息（`scan_depth_runs=4`），`on_mention` 使用普通子串匹配；`manual` 从本局选择项读取。扫描与基础历史裁剪由 [AgentContext](agent-context.md) 的构建函数执行，MVP 不支持递归、概率、Sticky/Cooldown、历史内部深度插入或跨分支关键词触发。

### 禁止隐式 Prompt 注入

原生格式不接受生效的 `load.role`、`injection_role/depth/order` 或 `data.prompts` 字段。旧来源可以归档在非执行扩展中；**对原生新卡应校验拒绝**未知的角色/深度注入控制，不能靠忽略非法字段掩盖内容行为差异。原世界卡 Prompt 如需生效，必须由用户明确导入为预设自定义文本节点。

## 文本规则与资源

文本规则可以定义输出转换和界面呈现需要的内容；规则是否在本局启用由实例或会话配置。导入内容中出现的 HTML、脚本和外部链接应保留，但导入成功不表示客户端支持其运行。

`assets[]` 是可选资源清单；可使用资源 ID 引用封面和角色头像。资源清单、资源路径和实际文件应区分：外链不等于已打包。PNG 角色卡可能以图片本身作为卡面；仅有 JSON 时不能恢复未提供的 PNG 头像。

## 来源迁移与保留

角色卡 V2/V3 仅作为内容来源，不要求世界卡继承其字段或结构。整理时：

- 将确定的人物设定整理到对应角色下；将独立世界资料、场景和对话示例整理到单个世界书。
- 原卡的开场白保留为开局；来源中的特殊入口应保留其内容。原来源中的 Prompt/注入字段不得自动转成生效配置；必要时存入不执行的扩展归档，供用户明确导入为自定义预设节点。
- 原来的关闭条目、旧版设定和不支持的扩展保留在原始来源归档；不要未经选择就把相互冲突的版本一起作为活跃世界设定。
- 原始数据与新卡分开保存。原始数据保留不代表所有旧字段或功能已转换完成。
- 关键词、旧版插入深度、正则和资源的原有行为需要逐项分析；旧版注入深度不属于世界卡生效规则，不能因保留了来源信息就宣称兼容运行效果。

## 示例与待讨论事项

世界卡整理示例见 [world-card.json](../examples/world-card.json)，其中状态树已改为强类型结构；原始角色卡及旧状态定义不做运行时自动兼容。示例中的角色许可与加载方式属于人工整理，不是源角色卡既有权限。

后续再讨论高级世界书触发、导入的正则和扩展兼容。Prompt 构建的确定性加载与合并规则见 [AgentContext](agent-context.md)。
