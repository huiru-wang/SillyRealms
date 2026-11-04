# 世界卡：唯一当前版本、角色、lorebook 与上下文策略

> 状态：领域设计，2026-11-04；强类型状态协议已同步，**尚未实现**。返回[文档索引](../README.md)，相关领域见[AgentContext](agent-context.md)、[会话](session.md)。

## 定位和内容归属

世界卡定义可重用的世界背景展示信息、独立角色、开局、**单个世界书**、可选状态字段及资源规则。**世界卡只负责内容与加载条件**；Preset 控制 Prompt 节点主顺序、角色和启停；世界书条目仅可选择预设允许的相对锚点及同锚点顺序，不得独立声明消息角色。命中条目与对应基础节点本体合并为一条 Prompt，角色继承目标节点，详见[Preset](preset.md)。

`data.description` 可以是 HTML 等展示内容，不自动进入 Prompt。故事前提、地点、事件、场景规则与示例等需供模型使用的信息属于 `data.lorebook.entries[]`；本期没有独立的 `scenes[]` 或 `examples` Prompt 插槽。角色的人物设定仍直接放在 `characters[]` 下。

用户扮演的 `user` 只能选当前世界卡 `characters[]` 中 `player_selectable=true` 的角色；若一个也没有，必须先在世界卡中**创建并保存**新角色，设置 `player_selectable=true`，再创建 Session。`Opening` 不单独限制可选角色。

## 当前唯一世界卡与实例引用

- `worlds.data_json` 只保存**一份当前世界卡**，不支持 draft、published 或历史内容版本；可以编辑、保存，创建 Session 时进行最基础的内容合法性校验。`spec_version` 仍表示文件**格式规范版本**，不是世界卡多版本机制。
- `sessions.world_id` 直接引用此世界卡，**每次交互重新读取最新 data_json**；Session 不复制世界快照，也不保存 opening_id。所选开局的正文在创建 Session 时就是第一条 Assistant Entry。
- 世界卡内容编辑立即影响旧 Session 的后续 Prompt。**允许旧状态失效**：若当前 Schema 与历史完整快照不兼容，下次状态读取可丢弃不兼容值并按最新状态定义的初值重建，不要求 Schema 迁移、不阻止继续旧剧情。原历史 Entry 仍然完整留存。
- `data.context` 是 WorldCard 专属的上下文策略配置，仅支持 `window`（默认）/`summary`，和模型参数、摘要 Prompt（属 Preset）相互独立。详见 [Context Strategy](context-strategy.md)。
- 若编辑世界卡时删除了某个 Session 所选的玩家角色，或将其 `player_selectable` 改为 false，下次进入该 Session 应要求重新选一个当前可选角色；没有可选角色时先创建并写回世界卡，再更新 Session.user_character_id。不得继续注入不存在的身份信息。

## 内容结构与导入边界

```text
WorldCard
├─ spec / spec_version
└─ data
   ├─ name / summary / description / tags / cover
   ├─ characters[]           独立角色及其加载配置
   ├─ openings[]             多个开局及可选世界状态初值覆盖
   ├─ context                可选上下文策略（window 默认 / summary）
   ├─ state                  可选强类型状态树（schema_version + modules）
   ├─ lorebook               单个世界书：entries[] 及各自 load
   ├─ regex_scripts[]        来源规则/可选扩展（MVP 不执行）
   ├─ assets[]               资源清单
   └─ extensions             非执行扩展/来源归档
```

结构外壳使用 `spec: "world_card"`、`spec_version: "0.1"`；`spec_version` 只表示导入导出**格式版本**，不作为世界卡业务版本。有效卡需要名称和至少一个 Opening；没有可玩角色时在创建 Session 之前要求用户新增角色并存入世界卡。未知来源字段可归档保留，但不能未经支持就生效。

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `name` | string，必填 | 世界卡名称 |
| `summary` | string | 列表简介，不发送模型 |
| `description` | string 或 `{format,content}` | 展示用说明，不自动发送模型 |
| `creator` / `creator_notes` | string | 作者与说明，不发送模型 |
| `tags` | string[] | 本地 `tags(type=world)` 标签 ID 数组；按 type 内 sort_order 排序展示 |
| `cover` | string | 可选 `asset:<ID>` 封面引用 |
| `characters[]` | array | 角色定义、可扮演许可及加载条件 |
| `openings[]` | array | 故事开局 |
| `lorebook` | object | 单个世界书，`entries[]` 存独立资料 |
| `context` | object，可选 | `strategy:window/summary`、`max_messages`、`keep_recent_messages`；规则见 [Context Strategy](context-strategy.md) |
| `state` | object，可选 | 唯一强类型状态定义 `schema_version + modules`；运行值不回写世界卡 |
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
| `player_selectable` | boolean，默认 `false` | 仅 `true` 可被选为玩家角色；若没有则创建新角色写入世界卡 |
| `order` | integer / `0` | 可选角色资料排序值，升序；同序按 characters 原数组顺序 |
| `state` | 旧导入字段，不在新原生卡启用 | 旧角色状态须显式映射进入 `data.state.modules`；所有角色状态统一管理，不仅限玩家角色 |

角色与世界书条目使用相同的基础加载条件，见下文「世界书与角色加载条件」。玩家在本局选中角色时，默认提供该角色资料；其他角色按其加载配置筛选，并最终填入预设的 `characterInfo` 插槽。

角色设定直接放在 `description`，不要求通过世界书关联。新原生卡的角色动态状态统一在 `data.state.modules[角色状态根名]` 声明，`characters[].state` 不再作为生效定义；导入旧角色状态时须显式映射并检查重名。**实际变化的快照不写回世界卡**；角色的控制者和是否登场也不写在世界卡。`player_selectable=true` 只表示该角色**可以**被选为 `user`，不是每局自动被玩家控制；Session 只保存该角色 ID，后续从世界卡最新数据读取完整角色设定。

## 开局

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `id` | string，必填 | 卡内稳定标识 |
| `name` | string，必填 | 选择开局时显示的名称 |
| `content` | string，必填 | 初始故事内容或特殊入口标记 |
| `initial_state` | object，可选 | 与运行快照同形的部分覆盖，根键对应 `data.state.modules`；固定 object 递归覆盖，array/json 叶子整值替换并接受强类型校验 |

**可选角色 = 世界卡中所有 `player_selectable=true` 的角色。** Opening 不设置 `player_characters`。如果当前可选角色为空，创建 Session 的流程必须提示用户新建一个完整角色，直接保存到当前 `worlds.data_json.characters[]` 并标记 `player_selectable=true`；然后选择该角色，Session 仅保存其 ID。

选择开局后将 `opening.content` 作为**第一条 Assistant Entry** 保存，首条消息附带基于当前 `data.state.modules` 的初始完整状态 S0，并允许 `opening.initial_state` 做受限覆盖，经过 Zod 校验。Session 不需要 opening_id，后续模型历史只通过 Entry 父链恢复，不重复注入 Opening。详见 [Session](session.md)。

## 强类型状态定义 `data.state`

状态是可选的独立插件，不替代叙事和世界书；此处只约定**世界卡存什么**，具体类型校验、Tool ChangeSet 和已完成 Assistant Entry 的全量状态快照统一由[状态规范](state.md)规定。

原生格式固定为 `{"schema_version":1,"modules":{...}}`，`modules` 每个根为 `type:"object"` 的类型树，根可以是 `世界`、某位角色、地点或组织，根名就是快照顶层键。角色状态不再拆为单独的 `characters[].state` 或仅保存 `user`，作者在同一棵树里声明所有需要跟踪的实体。每个根可以有自己的 `load` 规则，内层状态不能设置 `load`。 根加载只支持 `always / on_mention` 和可选 `when`；`when` 读取本分支**完整**状态。

支持 `string`、`number`、`integer`、`boolean`、`enum`、`object`、`array`、`json`。固定 `object` 用 `properties` 定义可嵌套字段，`array` 用 `items` 定义元素类型，`json` 是只能整值更新的弱类型逃生口；不从 `initial` 推断类型。普通作者在编辑器中只需填写**字段名/类型/初值/描述**，枚举、数值范围和 nullable 属于可选高级设置。每个已声明固定叶子都有初值，object 由其子字段初值递归生成。

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
        "背包": {"type": "json", "description": "键是物品 ID，物品变化时整体更新", "initial": {"灵石": {"数量": 3, "说明": "随身"}}}
      }}
    }
  },
  "openings": [{
    "id": "night", "name": "夜行", "content": "夜幕降临。",
    "initial_state": {"世界": {"当前时段": "夜晚"}}
  }]
}
```

`initial_state` 不包含任何 schema/description，不允许改变定义结构。Opening 局部覆盖只作用于声明的固定叶子，array/json 只做整值替换；统一编译的 Zod 先验证覆盖，再校验最终完整初始状态。旧 `{"当前时段": {"initial": ...}}`、独立角色 `state` 和旧 Opening 顶层字段均为**待迁移格式**，不对新格式偷偷做运行时兼容。

Agent 的三类受限操作为 `set/adjust/append`，由引擎按当前类型和已加载根自动开放，作者不配置更新命令。Tool Call 优先但依赖真实 Provider 验证，内联 `<StateUpdate>{"changes":[...]}</StateUpdate>` 是回退格式，详见[状态](state.md)。**JSON Patch / MVU 命令不再是模型输入契约。**

`load.when`、世界书条件和文本引用可用当前分支全量状态快照只读；在世界书正文/Prompt 中写 `{{state:/清月/灵力}}`，条件写 `get("/清月/灵力") < 20`。状态值和描述不能直接在卡片中执行 JS。

## 世界书与角色加载条件

一张原生世界卡拥有一个 `data.lorebook`，其中 `entries[]` 保存多个资料条目。`id` 在本世界书内部唯一，`title` 为显示标题，`content` 为模型可用正文。人物设定保存在角色定义中；地点、场景、组织、物品、历史事件、剧情规则和对话示例都可作为世界书条目。独立场景/示例来源内容可以归档，但 MVP 不隐式创建独立 Prompt 节点。

### 内容激活规则

角色 `load` 与世界书条目 `load` 都支持：

| 字段 | 类型 / 默认 | 作用 |
| --- | --- | --- |
| `mode` | `always/on_mention`，默认 `always` | 常驻或关键词加载；无手动模式 |
| `keywords` | string[] / `[]` | `on_mention` 触发词 |
| `keyword_logic` | `any/all` / `any` | 多关键词满足任一或全部 |
| `exclude_keywords` | string[] / `[]` | 仅对 `on_mention` 排除任意命中项 |
| `when` | string，可选 | 受限只读布尔表达式，在本轮最新完整状态快照上求值；对所有 mode 生效 |
| `order` | integer / `0` | **仅世界书 load.order**：同锚点同侧排序；角色排序由 `characters[].order` 顶层字段指定 |

`when` 是附加的 AND 条件：`always + when` 需要 when=true；`on_mention + keywords + when` 需要关键词逻辑命中**且** when=true；`exclude_keywords` 命中则不加载。缺少 when 即没有该附加限制；表达式读取当前分支最新全量状态，**不能**读截断前的聊天文本。

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

角色的 `load` 不接受 `anchor/position/role`，其资料进入 `characterInfo` 基础节点，先按 `order` 升序、同序再按角色原数组位置稳定排列；当前选为玩家的角色固定由 `personaInfo` 读取，不在 `characterInfo` 重复出现。世界书按 `(anchor,position,order,原始列表位置)` 稳定编排；同一条目在同一次构建中去重。`mode=always` 仍需要可选 `when` 为 true（若配置），但即便节点本体被关闭，该节点锚点仍能生成合并后的消息；具体见[Preset](preset.md)。

AgentContext 只扫描本轮**实际送给模型的 Narrative Context（仅 user/assistant 叙事）加当前 User**，不额外限制扫描深度。window 时是最近 N 条再按 Token 预算进一步缩窗，summary 时是最新 Summary + 未覆盖的保留消息；预算超限也会提前触发摘要。`on_mention` 用关键词匹配；若同时配置 `when`，必须 **关键词命中 AND when(fullState)=true**，排除关键词优先否决。世界书条件中的 `when` 由共享 [TextRenderer](text-rendering.md) 表达式引擎读取**完整状态**；索引按 anchor/position/order 稳定排序，节点由独立 NodeBuilder 执行 before/body/after，MVP 不支持递归、概率、Sticky/Cooldown、历史内部深度插入或跨分支关键词触发。

### 禁止隐式 Prompt 注入

原生格式不接受生效的 `load.role`、`injection_role/depth/order` 或 `data.prompts` 字段。旧来源可以归档在非执行扩展中；**对原生新卡应校验拒绝**未知的角色/深度注入控制，不能靠忽略非法字段掩盖内容行为差异。原世界卡 Prompt 如需生效，必须由用户明确导入为预设自定义文本节点。

本地标签是通用 `tags(id,type,name,sort_order)` 字典，`data.tags` 引用 `type=world` 的标签 ID；UI 按 `sort_order/name` 排序。导入来源标签名称时先映射为标签字典 ID，不建立 `world_tags`。

## 文本规则与资源

文本规则可以定义输出转换和界面呈现需要的内容；共享 TextRenderer 可读取当前状态，规则配置在当前世界卡或预设中，不需要 Session options_json。导入内容中出现的 HTML、脚本和外部链接应保留，但导入成功不表示客户端支持其运行。

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
