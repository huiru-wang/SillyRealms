# 持久化与接口：SQLite 数据模型

> 状态：技术方案草案，2026-11-01；以下为逻辑结构和可选 DDL，并非已执行的数据库迁移。返回[文档索引](../README.md)。

## 事实来源和结构约定

一个 Session 对应整棵 Entry 树，JSON 保存世界卡与预设完整定义，Entry 独立存储。**只有 SQLite 是持久化权威来源**；压缩结果、运行时对象和 UI 缓存不能反向覆盖真实历史。领域规则分别归属[世界卡](../design/world-card.md)、[会话](../design/session.md)、[Context](../design/context.md)和[配置](../design/configuration.md)。

## 数据表设计原则

- 所有表均**不设计数据库外键**。引用关系由应用在事务中检查，数据库不执行级联删除。
- 稳定 ID 使用 TEXT；时间使用 UTC 毫秒整数。字段中的 JSON 使用 TEXT 保存并验证格式。
- 查询和唯一性使用主键、唯一索引和普通索引；不因没有外键就省略引用校验。
- JSON 用于世界卡和预设等完整定义；消息独立存储，避免每轮重写完整会话。
- 表结构与 SQLite 驱动尚未确定，以下是 MVP 逻辑表设计，不是已执行的 DDL。

### 世界与会话

| 表 | 字段 | 用途 |
| --- | --- | --- |
| `worlds` | `id` 主键、`name`、`draft_json`、`published_json` 可空、`version` TEXT 可空、`created_at`、`updated_at`、`published_at` 可空 | 世界当前草稿和最新发布内容及两段内容版本；不保存历史版本 |
| `sessions` | `id` 主键、`world_id`、`title`、`world_snapshot_json`、`source_world_version` TEXT、`preset_id`、`active_leaf_entry_id` 可空、`created_at`、`updated_at` | 一条记录是一局世界实例，包含一棵 Entry 树；来源版本仅此一个字段 |
| `entries` | `id` 主键、`session_id`、`parent_entry_id` 可空、`seq`、`role`、`content`、`status`、`created_at`、`updated_at`；**状态功能阶段新增** `state_snapshot_json`、`state_status` 及版本校验信息 | 有父子关系的真实用户/AI 消息；状态启用时每条消息保存完整快照，`seq` 不用于历史游标 |

世界卡内容发布、版本递增与手动实例同步的业务语义以[世界卡领域设计](../design/world-card.md)为准；原生世界卡不接受可生效的 Prompt 注入位置/角色/顺序及 `data.prompts`；旧导入元数据只能归档或显式转为用户预设文本节点。本表只存 `worlds.version` 与实例单个 `source_world_version`，同步事务更新 JSON 快照与来源版本，不影响 Entry 树或既有状态快照。新卡 `data.state` 与现有快照的结构必须先做兼容性检查。

首期 `entries.role` 只要求用户/AI 可见消息；`status` 区分生成中、完成、失败/中断，内建工具事件需要未来单独持久化和恢复。普通消息形成单链，但底层始终使用父子指针；MVP 只允许按 `active_leaf_entry_id` 的单条祖先链向上分页，参见下文「一致性、索引和分页」；分叉直接由已有 AI Entry 的多个 User 子节点表达，不需要附加分叉选项表；压缩检查点可分期增加。导入原始角色卡数据单独保留时，不视作已转换完成的世界内容。

### 预设与 API 连接

| 表 | 字段 | 用途 |
| --- | --- | --- |
| `presets` | `id` 主键、`name`、`api_connection_id`、`config_json`、`created_at`、`updated_at` | 只保存用户自定义预设；`config_json` 包含 `base_preset_id: "builtin/default"`、**完整的已排序 `nodes[]`**（10 个系统节点 + 自定义文本节点）及模型生成参数，不维护版本历史 |
| `api_connections` | `id` 主键、`name`、`platform`、`base_url`、`credential_ref` 可空、`model_id`、`created_at`、`updated_at` | 一条 API 连接包含名称、模型平台、地址、凭据引用与选中的模型 |

内置 `builtin/default` 为应用随代码提供的**只读模板，不通过 `presets` 表作为可编辑用户记录**；新预设从模板复制为完整节点数组，基础 ID/类型/source 不可更改、不得删除或重复，`chatHistory` 强制开启。导入时验证后才保存；预设数组是运行顺序的唯一来源，世界卡的 `injection_*` 与 `data.prompts` 不得执行，也不创建第二张节点顺序表。预设与 API 连接的用户配置、生效优先级和删除策略见[配置领域设计](../design/configuration.md)。`api_connections.credential_ref` 仅指向本地安全凭据，API Key 不写进 JSON、普通导出或消息；具体密钥存储实现需验证。

### 通用标签

| 表 | 字段 | 用途 |
| --- | --- | --- |
| `tags` | `id` 主键、`target_type`、`target_id`、`name`、`name_key`、`created_at` | 一条记录表示一个对象拥有一个标签；按类型和对象查询 |

`target_type` 表示标签归属对象类型，例如 `world`；未来可扩展 `character`、`scene`、`session`。角色、场景属于世界卡内部对象时，其全局标识规则需先明确，不能假定卡内 ID 全局唯一。唯一索引建议为 `(target_type, target_id, name_key)`，并建立 `(target_type, name_key, target_id)` 查询索引。

此表直接存放对象与标签的对应关系，不另建标签定义表。世界卡 JSON 的标签用于导入导出；数据库标签作为列表搜索索引，保存世界卡时由同一事务更新。修改方式和大小写归一化规则需要统一，避免数据不同步。标签不自动成为关键词或 Prompt。

### 迁移记录

| 表 | 字段 | 用途 |
| --- | --- | --- |
| `schema_migrations` | `version` 主键、`applied_at` | 数据库结构迁移记录 |

首期**不设计** `world_assets`、`entry_attachments`、`models`、`memories`、独立 `state_checkpoints` 表、`branches`、`branch_options` 或 `runs` 表；`context_checkpoints` 由压缩阶段按 Entry 锚点引入。**状态功能是后续能力**：状态落在每条 Entry 的完整快照中，不以只存 Patch + 重放作为正常读取来源。AI 帮答行动项只是用户输入候选，不持久化为分支。世界卡中的资源引用可以保留，但资源文件管理不在本表设计范围。

## 一致性、索引和分页

主要索引：`entries(session_id, seq)` 唯一、`entries(session_id, parent_entry_id)` 用于查询某 AI 的直接 User 分支与祖先链，`sessions(world_id, updated_at)` 用于世界下的实例列表；标签索引维持原设计。主键和索引不属于外键。

所有引用由服务层校验：写入消息前确认会话存在；创建会话时确认世界已发布、预设和 API 连接可用；修改世界、预设、连接和对象标签时检查相关引用并采取用户可见的保留、解除或拒绝策略，不留悬空引用。**消息删除 API 当前禁止**，不能用直接删除 Entry 或级联删除代替产品确认。多项关联写入在短事务中完成；并发更新使用事务和应用层冲突检查。禁止用数据库外键或级联删除替代这些规则。

**MVP 进入 Session 只读活动世界线末尾：**打开时校验 `active_leaf_entry_id` 是本实例内真实叶子，读取最近约 30 条祖先消息、正序展示；向上翻页以当前页最早 Entry ID 为 `before`，返回严格在其之前的祖先。聊天**没有** `view_leaf_entry_id`、设备历史锚点恢复、任意 Entry 窗口或向下分页。分页响应绑定读取时的 `leaf_id`；客户端**跨世界线切换**必须清理旧列表、游标及未完成请求；**同线生成**形成新叶子时更新请求绑定、取消/重试旧游标请求，但保留仍属于祖先链的已加载消息及当前滚动位置。`seq` 只用于创建顺序和同 Session 唯一性，绝不可作为单条分支的历史游标。详细协议和 SQL 见下文。

每次新增消息仍须在短事务中获得唯一递增 `seq`，并校验同实例父节点、无环、每个 AI 最多 3 个直接 User 子节点、每个 User 最多 1 个有效 AI 子节点；只有显式世界分叉请求可从历史 AI 节点添加另一条 User。H5 同时限制渲染数量并保持向上插入的可见锚点。

## 显式分叉、编辑与叶子操作的事务约束

- **创建分叉**：接口传入历史 `source_user_entry_id` 与新用户输入 `content`，服务端在事务中读取该 User 的 `parent_entry_id`（必须是已完成 AI Entry），确认它在同一 Session 且已有 User 子节点数少于 3，再创建 `new_user_entry(parent=source_user.parent_entry_id)`。用户打开输入框、取消或调用 AI 帮答时不写入 Entry。
- `seq` 分配及分叉上限检查必须在同一写事务完成；请求幂等 ID 防止重复点击创建重复分支。Agent 回复为该新 User 的唯一有效 AI 子节点，模型执行时不持有数据库长事务。发送失败可恢复并重试，不能重复新增 User 分支。
- **世界线预览与切换**：前端总览临时 `selected_leaf_id` 只高亮，不查询普通历史，不更新 Session。点击「进入这条世界线」时，服务端校验目标属于同一 Session 且**无子节点**，用预期旧活动叶子做并发条件，原子更新 `sessions.active_leaf_entry_id`；显式新分叉生成也更新活动叶子。切换后从新叶子**最近一页**重新进入聊天。模型生成请求绑定它开始时确认的父节点与活动叶子，不许切线后把迟到结果写到另一条世界线。
- **重生成/AI 续写**：仅当目标是当前选中路径末尾的 AI Entry 且无子节点时可执行；重生成更新同一 Entry 的正文，续写追加至同一 Entry 的正文。不新增父子节点，不触发分叉；中断失败保留可恢复正文。
- **编辑历史**：允许用户主动更新任意已保存且没有运行中写冲突的 User/AI Entry 的 `content`（以及 `updated_at`），**不自动生成、改写或删除任何后代 Entry**。编辑共同祖先影响多条路径，UI 需明确提示。依赖该消息旧内容的 Context/摘要/记忆/状态派生数据需失效或重建，路径无关数据保留。
- **删除消息暂不支持**：不设计 `DELETE /sessions/:id/entries/:entry_id` 或自动剪枝/重连父子链的用户操作；子树删除、历史编辑审计等作为后续独立方案。

## 世界状态快照与结算（后续状态功能）

**卡片结构与初始化：** 世界卡 `data.state` 是顶层字段 ID → `{initial, description, rule}` 的映射，JSON 初值决定字段类型（字符串/数值/布尔/数组/对象）；仅初值为 `null` 时额外要求 `type`。`openings[].initial_state` 只覆盖已定义字段的整个初值，不能新增字段或修改规则；对象与数组按**字段整值替换**，不递归合并。创建 Session 时从已发布的世界卡快照计算默认状态，再应用选中 Opening 的覆盖，保存为**开局根 Entry 的完整初始状态快照**。开局不额外触发状态变化分析。无 `data.state` 的实例不需要状态快照。

**Entry 的目标持久化字段：** `state_snapshot_json` 保存当前 Entry 的**完整**状态值（无需回溯或重放才可获得该消息的值）；`state_status` 区分开局/AI 已结算 `settled`、User 原样继承 `inherited`，以及 `pending`、`failed`、`stale`。即使无变化也复制完整快照；允许待结算 Entry 暂存继承值但必须标明 `pending`，不能伪装成有效的新结算。状态启用后还需保存或校验**消息正文修订版本、父快照修订版本和状态定义指纹**，防止异步旧结果写回；精确列名与 DDL 以后随实际状态模块一起确定。

**Agent 与确定性更新：** User Entry 在写入时继承其父 Entry 的完整已结算状态；AI 叙事完成后，Agent 对实际发生的故事输出结构化操作列表（可以为空），引擎从其父 User 快照执行 `set/add/insert/delete/move`，整批原子校验和写入后保存完整新快照，失败不部分落盘。`set` 替换已定义字段的同类型值，`add` 仅数值，`insert/delete/move` 仅作用于数组或对象的具体成员；**不可删除顶层状态字段**，也不能由 Agent 改变 Schema。精确操作语义参见[世界卡](../design/world-card.md)。不执行用户世界卡里的任意脚本。

**幂等、分叉与失效：** 更新按 Entry ID、消息正文版本、父状态版本识别，不重复对同一结果执行 `add/insert`。分叉子 Entry 直接复制其**父 AI Entry 的状态**，不读取其他世界线的最新值。AI 末尾重生成或续写须以同一父快照重新结算（不能在旧 AI 快照上叠加）。历史消息正文被用户编辑后，保留全部后代消息和已有历史快照用于查看，但该消息及相关后代快照标记 `stale`，之后的生成不能把它当作有效状态；修复或重算状态是独立的后续操作，**不自动重生成叙事文本**。

**世界卡同步：** 实例手动同步新发布的世界卡仍只修改 `world_snapshot_json` 与 `source_world_version`，不重置 Opening、不改写任一 Entry 的快照。状态字段新增、删除、重命名、类型改变可能导致旧快照不兼容；同步时需明确提示并阻止不兼容的状态规则直接生效，直至制定显式迁移方案。不凭世界卡版本号直接推断状态一定兼容。

## MVP 查询与 API 草案

### 聊天：最近一页 + 仅向上祖先分页

| 接口 | 用途 |
| --- | --- |
| `GET /sessions/:id/entries?limit=30` | 从服务端当前 `active_leaf_entry_id` 向祖先取最新一页；正序返回 |
| `GET /sessions/:id/entries?leaf_id=A900&before=U850&limit=30` | 在同一活动叶子路径上取严格早于 `before` 的祖先消息 |
| `GET /sessions/:id/worldlines` | 压缩拓扑预览：仅 Root/Fork/Branch Start/Leaf 与边，隐藏中间消息 |
| `GET /sessions/:id/worldlines?subtree_root_id=...` | 超大拓扑时按真实子树根分段展开压缩摘要，不读取中间正文 |
| `PUT /sessions/:id/active-leaf` | 用户明确选择真实叶子并进入；要求 `leaf_id`、`expected_active_leaf_id` |
| `POST /sessions/:id/forks` | 显式从历史 User 建立分支：`source_user_entry_id`、`content`、幂等 ID |
| `POST /sessions/:id/generate` | 从当前活动真实叶子创建普通 User 输入、生成 AI；带预期父叶子/幂等 ID |
| `POST /sessions/:id/entries/:entry_id/regenerate` | 若后续功能启用，仅编辑当前末尾 AI Entry 正文，不新增分叉 |
| `POST /sessions/:id/entries/:entry_id/continue` | 若后续功能启用，仅追加到当前末尾 AI Entry 正文 |
| `PATCH /sessions/:id/entries/:entry_id` | 用户编辑已加载历史 Entry，不删后代，失效受影响派生数据 |
| `POST /sessions/:id/compact` | 未来的派生历史压缩，不改写真实 Entries |

**MVP 不提供** `GET /entries?after=...`、`GET /entries/window`、`GET /tree` 返回全量 Entry、任意 Entry 直接定位、读取中间历史窗口或消息删除 API。

返回协议示例（内容仅示意）：

```json
{
  "leaf_id": "A900",
  "entries": [
    {"id": "U899", "parent_entry_id": "A898", "role": "user", "content": "继续前往王宫", "status": "completed", "fork_child_count": 0},
    {"id": "A900", "parent_entry_id": "U899", "role": "assistant", "content": "王宫的大门缓缓打开", "status": "completed", "fork_child_count": 0}
  ],
  "next_before": "U899",
  "has_more": true
}
```

- `leaf_id` **首次请求可省略**，由服务端读取当前活动叶子；带 `before` 的续页请求必须传上次响应的 `leaf_id`。如果传入旧叶子，或 `before` 不在该叶子的祖先路径上，返回冲突/无效游标，不退化成全 Session `seq` 查询。`before` 本身不重复出现；到根时 `has_more=false`、`next_before=null`。服务端限制 `limit`（默认 30，最高如 100），多取 1 条判断是否还有祖先。
- `fork_child_count` 只针对**已加载的 AI Entry**查询它实际直接 User 子节点数，可批量按 `parent_entry_id IN (...)` 查统计；0/1 不显示分叉标记，2 或 3 显示。不能从该页是否包含某个子节点来推断分叉数。
- 客户端发起分页时捕获 `leaf_id` 和本地 `navigation_epoch`；**跨世界线切换**时丢弃旧列表与请求，**同线正常生成**改变活动叶子后只重新绑定分页游标/取消旧请求，保留已加载的祖先内容与视觉锚点，用户正在阅读旧消息时不强行跳到底部。服务端生成与选叶子必须检查预期活动叶子并拒绝冲突；不能因为 UI 竞态把 A 分支分页结果显示在 B 分支。
- `User` 也可以是 `leaf_id`（AI 失败/等待回复），返回其状态和恢复入口；不猜测存在隐含的 AI 子节点。

### SQLite 祖先查询示例

```sql
-- :start_entry_id = 首屏的 active_leaf_entry_id；
-- 续页时 = 经过路径校验的 before Entry 的 parent_entry_id。
-- :limit = 本页条数；深度 0..:limit 共取最多 limit+1 条。
WITH RECURSIVE ancestors(id, parent_entry_id, depth) AS (
  SELECT id, parent_entry_id, 0
  FROM entries
  WHERE id = :start_entry_id AND session_id = :session_id
  UNION ALL
  SELECT parent.id, parent.parent_entry_id, a.depth + 1
  FROM ancestors AS a
  JOIN entries AS parent ON parent.id = a.parent_entry_id
  WHERE parent.session_id = :session_id AND a.depth < :limit
)
SELECT e.id, e.parent_entry_id, e.role, e.content, e.status, ancestors.depth
FROM ancestors JOIN entries AS e ON e.id = ancestors.id
ORDER BY ancestors.depth DESC;
```

按 `depth` 选择**最近的 `limit` 条**；当查询返回 `limit+1` 条时，`has_more=true`，必须**丢弃 `depth` 最大的那条最老消息**，再按 `depth DESC` 展示剩余消息（从旧到新）。多出的第 31 条只用于检测是否还有历史，不能错误地显示并遗漏最新的一条。`before` 是否属于目标叶子祖先链需要单独做路径存在性校验（可使用递归 CTE），且必须验证 `before.session_id`、`leaf_id` 和当前活动叶子一致；不能只信任请求传来的 `before.parent_entry_id`。异常父链、循环、跨实例链接须失败而不是无限递归；即使无数据库外键也必须有服务层防护。

**重要：** UI 只查询 30 条，不意味着 Context 只使用 30 条。模型生成以固定叶子祖先路径读取完整有效历史，并按 Token 预算/检查点决定实际发送；两者不可混用聊天列表游标。

### 全局世界线：只传保留节点和隐藏边

**逻辑定义：**保留根 Opening（`root`）、直接拥有至少 2 个 User 子 Entry 的 AI（`fork`）、每个实际 `fork` 的直接 User 子 Entry（`branch_start`）及每个没有子节点的真实末尾（`leaf`）。单个节点可能同时属于多类，以 `kinds[]` 表示。其他连续 Entry 不作为 UI 节点；任意相邻保留节点之间生成连接边及 `hidden_count`，值由实际父子路径深度差减 1 得出，**绝不使用 `seq` 相减**。

```json
{
  "active_leaf_id": "A900",
  "nodes": [
    {"id":"A0", "kinds":["root"], "preview":"王城开局"},
    {"id":"A83", "kinds":["fork"], "child_count":2, "preview":"守卫要求通行证"},
    {"id":"U84", "kinds":["branch_start"], "preview":"我出示通行证"},
    {"id":"U85", "kinds":["branch_start"], "preview":"我绕到侧门"},
    {"id":"A900", "kinds":["leaf"], "status":"completed", "preview":"王宫大门打开"},
    {"id":"U300", "kinds":["leaf"], "status":"failed", "preview":"等待重试"}
  ],
  "edges": [
    {"from":"A0", "to":"A83", "hidden_count":82},
    {"from":"A83", "to":"U84", "hidden_count":0},
    {"from":"A83", "to":"U85", "hidden_count":0},
    {"from":"U84", "to":"A900", "hidden_count":815},
    {"from":"U85", "to":"U300", "hidden_count":40}
  ],
  "has_more": false
}
```

**构建方式**：服务端可一次扫描该 Session 的**轻量元数据列**（`id`、`parent_entry_id`、`role`、`status`），用父子关系建立拓扑并标记 Fork/Branch Start/Leaf，再仅对**实际保留节点**批量读取短预览；不拉取每条消息的完整 `content`。构图和 `hidden_count` 统计需近似 O(本实例 Entry 总数)，避免对每个叶子再从根重复遍历。可缓存拓扑，但缓存不得成为事实来源；新增分支/生成、编辑节点正文、切换活动叶子后应使相关缓存失效。

**超大分叉树**：客户端不应一次渲染无界节点；服务端应有限额。超过上限时，优先返回 `has_more=true`、`collapsed_subtree_roots`（真实节点 ID）供前端标记折叠段，再通过 `?subtree_root_id=...` 按子树获取其保留节点和边；若无法提供可继续展开的结果，则明确返回 `topology_too_large`，由 UI 引导缩小范围。**不能**无标记截断并伪装成完整世界线。该保护不应改变普通上千条单链消息的压缩效果；初版实现需用大量叶子测试验证子树展开的完备性。

叶子选择示例：

```http
PUT /sessions/{sessionId}/active-leaf
Content-Type: application/json

{"leaf_id":"A900","expected_active_leaf_id":"U300"}
```

服务端用写事务确认目标 `leaf_id` 同实例、没有任何子 Entry（不限定必须是 AI）、没有冲突生成，再使用 `WHERE id=:session_id AND active_leaf_entry_id=:expected_active_leaf_id` 原子更新；条件不满足返回 409 和最新活动叶子。中间 Fork 或 Branch Start **不是叶子**，不能直接作为活动入口。页面预览中临时选中 `selected_leaf_id` 不发该 PUT；只有用户确认进入才更新，之后清空列表并重新请求该新叶子的最新一页。

## 同步事务与历史压缩数据

- 世界卡同步使用一次短事务：将已发布 `worlds.published_json`、`worlds.version` 分别复制为实例 `sessions.world_snapshot_json`、`sessions.source_world_version`，可更新 `updated_at`；禁止使用未发布草稿或触碰 Entry 树、分叉关系、已有状态快照或已选交互叶子。若启用了 `data.state`，同步前必须检查新旧状态定义的兼容性，不兼容时拒绝隐式启用并提示显式迁移。
- `context_checkpoints` 在历史压缩阶段引入，最小持久化字段包括 `id`、`session_id`、`anchor_entry_id`、摘要文本、用于有效性检查的世界快照/Context 指纹及时间。具体 DDL 等待 Pi 接入与压缩可行性验证。
- 检查点仅对**锚点在当前叶子祖先链**上的路径有效。编辑历史节点 X 后，对覆盖 X 内容的检查点（锚点为 X 或其后代）标记失效或重新计算；严格位于 X 之前的检查点仍可有效。原始消息保留可分页；未来记忆与状态遵循类似的祖先隔离规则。

## 备份、迁移和回退

数据库位于独立数据目录，不覆盖世界卡原始素材。迁移失败应停止写入并保留可用的旧数据库；运行中使用 SQLite 的一致性备份能力或经过验证的快照备份，不依赖简单复制 WAL 运行时主文件。普通导出不含密钥，恢复不应悄悄覆盖现有用户故事。

## 数据验证

- 两段世界版本与 Session 唯一来源版本；同步不改变消息、分叉关系、已有状态快照和交互叶子；不兼容状态定义不直接生效。
- 系统默认预设不可修改/删除/覆盖，导入预设和保存自定义预设时必须完整保留 10 个不重复的基础节点、固定 source，`chatHistory` 强制开启；世界卡中的旧注入规则不能改变节点顺序或角色。
- 应用层同实例引用校验、父子无环、唯一根约束、并发 `seq` 分配；在历史 User 处发起分叉，新增其父 AI 的 User 子节点，不超过 3 条；重复请求幂等且不会误建第四分支。
- 打开实例仅从活动叶子取最近一页，向上游标仅沿父链，`before` 须属于当前活动叶子；没有向下历史分页或任意 Entry 窗口。1000+ 条单世界线只加载必要消息页，旧叶子游标切换后立即失效。
- 全局世界线仅返回 Root/Fork/Branch Start/Leaf 及带 `hidden_count` 的边，不全量返回正文；叶子高亮仅保留前端 `selected_leaf_id`。用户确认进入后校验真实叶子与预期活动叶子，再更新持久化 `active_leaf_entry_id`、清空聊天列表并加载最新一页。
- 取消/失败恢复（含失败 User 叶子）、服务重启、不同叶子的 Context 压缩可见性；仅末尾 AI 可重生成/续写，编辑历史不自动生成后代且派生 Context/状态失效；消息删除接口不存在，迁移回滚后数据一致。
- 状态功能验证：不同 Opening 的初始值整字段覆盖；User 继承、AI 结算、无变化仍完整快照；`set/add/insert/delete/move` 合法性及不可删除顶层字段；同一 AI 消息重算幂等；分支间状态隔离；历史编辑后 `stale`；不兼容世界卡同步拒绝无声迁移。
