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

世界卡内容发布、版本递增与手动实例同步的业务语义以[世界卡领域设计](../design/world-card.md)为准；本表只存 `worlds.version` 与实例单个 `source_world_version`，同步事务更新 JSON 快照与来源版本，不影响 Entry 树或既有状态快照。新卡 `data.state` 与现有快照的结构必须先做兼容性检查。

首期 `entries.role` 只要求用户/AI 可见消息；`status` 区分生成中、完成、失败/中断，内建工具事件需要未来单独持久化和恢复。普通消息形成单链，但底层始终使用父子指针，路径分页参见下文「一致性、索引和分页」；分叉直接由已有 AI Entry 的多个 User 子节点表达，不需要附加分叉选项表；压缩检查点可分期增加。导入原始角色卡数据单独保留时，不视作已转换完成的世界内容。

### 预设与 API 连接

| 表 | 字段 | 用途 |
| --- | --- | --- |
| `presets` | `id` 主键、`name`、`api_connection_id`、`config_json`、`created_at`、`updated_at` | 配置上下文长度、温度、惩罚项、Top P、帮答、续写、自建提示词及编排顺序；只保存当前配置 |
| `api_connections` | `id` 主键、`name`、`platform`、`base_url`、`credential_ref` 可空、`model_id`、`created_at`、`updated_at` | 一条 API 连接包含名称、模型平台、地址、凭据引用与选中的模型 |

预设与 API 连接的用户配置、生效优先级和删除策略见[配置领域设计](../design/configuration.md)。`api_connections.credential_ref` 仅指向本地安全凭据，API Key 不写进 JSON、普通导出或消息；具体密钥存储实现需验证。

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

打开会话先定位有效 `active_leaf_entry_id`，默认将其用于客户端的 `view_leaf_entry_id` 并只读取最近一页祖先消息；若设备保存了同一阅读路径上的滚动锚点，可以围绕锚点恢复阅读窗口。向上和向下的历史游标都绑定固定 `leaf_id`，沿 `parent_entry_id` 得到单一祖先链、校验游标属于该路径，绝不能用 `(session_id, seq)` 拼接跨分支消息。每次新增消息仍须在短事务中获得唯一递增 `seq`，并校验同实例父节点、非环以及每个 AI 最多 3 个直接 User 子节点、每个 User 最多 1 个有效 AI 子节点；只有显式世界分叉请求可以向已有后续的历史 AI 节点添加另一条 User 路线。H5 同时限制渲染数量并保持上滑位置。

## 显式分叉、编辑与叶子操作的事务约束

- **创建分叉**：接口传入历史 `source_user_entry_id` 与新用户输入 `content`，服务端在事务中读取该 User 的 `parent_entry_id`（必须是已完成 AI Entry），确认它在同一 Session 且已有 User 子节点数少于 3，再创建 `new_user_entry(parent=source_user.parent_entry_id)`。用户打开输入框、取消或调用 AI 帮答时不写入 Entry。
- `seq` 分配及分叉上限检查必须在同一写事务完成；请求幂等 ID 防止重复点击创建重复分支。Agent 回复为该新 User 的唯一有效 AI 子节点，模型执行时不持有数据库长事务。发送失败可恢复并重试，不能重复新增 User 分支。
- **阅读与选择叶子分离**：`view_leaf_entry_id`、`focused_entry_id` 与 `scroll_anchor` 是客户端临时阅读导航状态（后者可按设备缓存），**不直接写入 Session 的交互叶子**。只有用户明确选择「在此世界线继续」，服务端校验目标是同一 Session 的真实叶子后才更新 `sessions.active_leaf_entry_id`；显式新分叉生成并确认新的真实叶子后亦可更新。模型生成请求明确携带实际交互叶子并进行一致性检查，避免并发切线误写。
- **重生成/AI 续写**：仅当目标是当前选中路径末尾的 AI Entry 且无子节点时可执行；重生成更新同一 Entry 的正文，续写追加至同一 Entry 的正文。不新增父子节点，不触发分叉；中断失败保留可恢复正文。
- **编辑历史**：允许用户主动更新任意已保存且没有运行中写冲突的 User/AI Entry 的 `content`（以及 `updated_at`），**不自动生成、改写或删除任何后代 Entry**。编辑共同祖先影响多条路径，UI 需明确提示。依赖该消息旧内容的 Context/摘要/记忆/状态派生数据需失效或重建，路径无关数据保留。
- **删除消息暂不支持**：不设计 `DELETE /sessions/:id/entries/:entry_id` 或自动剪枝/重连父子链的用户操作；子树删除、历史编辑审计等作为后续独立方案。

## 世界状态快照与结算（后续状态功能）

**卡片结构与初始化：** 世界卡 `data.state` 是顶层字段 ID → `{initial, description, rule}` 的映射，JSON 初值决定字段类型（字符串/数值/布尔/数组/对象）；仅初值为 `null` 时额外要求 `type`。`openings[].initial_state` 只覆盖已定义字段的整个初值，不能新增字段或修改规则；对象与数组按**字段整值替换**，不递归合并。创建 Session 时从已发布的世界卡快照计算默认状态，再应用选中 Opening 的覆盖，保存为**开局根 Entry 的完整初始状态快照**。开局不额外触发状态变化分析。无 `data.state` 的实例不需要状态快照。

**Entry 的目标持久化字段：** `state_snapshot_json` 保存当前 Entry 的**完整**状态值（无需回溯或重放才可获得该消息的值）；`state_status` 区分开局/AI 已结算 `settled`、User 原样继承 `inherited`，以及 `pending`、`failed`、`stale`。即使无变化也复制完整快照；允许待结算 Entry 暂存继承值但必须标明 `pending`，不能伪装成有效的新结算。状态启用后还需保存或校验**消息正文修订版本、父快照修订版本和状态定义指纹**，防止异步旧结果写回；精确列名与 DDL 以后随实际状态模块一起确定。

**Agent 与确定性更新：** User Entry 在写入时继承其父 Entry 的完整已结算状态；AI 叙事完成后，Agent 对实际发生的故事输出结构化操作列表（可以为空），引擎从其父 User 快照执行 `set/add/insert/delete/move`，整批原子校验和写入后保存完整新快照，失败不部分落盘。`set` 替换已定义字段的同类型值，`add` 仅数值，`insert/delete/move` 仅作用于数组或对象的具体成员；**不可删除顶层状态字段**，也不能由 Agent 改变 Schema。精确操作语义参见[世界卡](../design/world-card.md)。不执行用户世界卡里的任意脚本。

**幂等、分叉与失效：** 更新按 Entry ID、消息正文版本、父状态版本识别，不重复对同一结果执行 `add/insert`。分叉子 Entry 直接复制其**父 AI Entry 的状态**，不读取其他世界线的最新值。AI 末尾重生成或续写须以同一父快照重新结算（不能在旧 AI 快照上叠加）。历史消息正文被用户编辑后，保留全部后代消息和已有历史快照用于查看，但该消息及相关后代快照标记 `stale`，之后的生成不能把它当作有效状态；修复或重算状态是独立的后续操作，**不自动重生成叙事文本**。

**世界卡同步：** 实例手动同步新发布的世界卡仍只修改 `world_snapshot_json` 与 `source_world_version`，不重置 Opening、不改写任一 Entry 的快照。状态字段新增、删除、重命名、类型改变可能导致旧快照不兼容；同步时需明确提示并阻止不兼容的状态规则直接生效，直至制定显式迁移方案。不凭世界卡版本号直接推断状态一定兼容。

## 查询与 API 草案

| 接口 | 语义 |
| --- | --- |
| `GET /sessions/:id/tree` | 返回真实 Entry 的 `id/parent_entry_id/role/status/preview` 等元数据，按 AI 的直接 User 子节点推导分支数；可按需加载子树 |
| `GET /sessions/:id/entries?leaf_id=...&before_entry_id=...&limit=...` | 固定阅读叶子祖先链的**向上**分页（更早消息） |
| `GET /sessions/:id/entries?leaf_id=...&after_entry_id=...&limit=...` | 固定阅读叶子祖先链的**向下**分页（更晚消息），不混入同一 AI 节点的其他子分支 |
| `GET /sessions/:id/entries/window?anchor_entry_id=...&leaf_id=...&before=15&after=15` | 任意消息定位：读取目标前后的消息窗口；有确定阅读叶子时要求 anchor 属于该叶子的祖先链，未确定下行路线时可只取目标及其祖先 |
| `POST /sessions/:id/forks` | **显式**从历史 User 消息处创建世界分叉，提供 `source_user_entry_id`、新用户 `content`、幂等 ID，创建真实 User Entry 并正常生成 |
| `POST /sessions/:id/select-leaf` | 校验并更新当前选中叶子 |
| `POST /sessions/:id/generate` | 在当前叶子普通发送 User 消息并生成回复，不因选用 AI 帮答而触发分叉 |
| `POST /sessions/:id/entries/:entry_id/regenerate` | 仅重新生成当前路径末尾 AI 消息，更新同一 Entry |
| `POST /sessions/:id/entries/:entry_id/continue` | 仅为当前路径末尾 AI 消息续写，追加同一 Entry |
| `PATCH /sessions/:id/entries/:entry_id` | 用户编辑历史消息正文，保留所有后代，失效受影响派生 Context |
| `POST /sessions/:id/compact` | 按叶子历史创建/更新派生压缩摘要，不改写 Entries |

**无消息删除接口**。AI 帮答的候选行动生成属于普通输入辅助，不是 `forks` 也不产生分叉数据；其单独接口可后续设计。

**双向历史游标**使用固定 `leaf_id` 加互斥的 `before_entry_id` / `after_entry_id`（或等效签名游标），服务端校验锚点属于该叶子的祖先链，并以 `parent_entry_id` 推导其在唯一历史路径上的前后关系。返回结果按阅读顺序排列，不使用全实例 `(session_id, seq)` 过滤来假装处理分支。打开会话只取最近一页；上滚请求祖先，下滚请求该叶子路径上的较新后代。切换阅读叶子后必须使旧路径的游标和缓存窗口失效。请求须有合理分页上限及异常环路防护。

**任意消息窗口定位**使用 `anchor_entry_id` 与可选的 `leaf_id`。有明确阅读叶子时校验 anchor 属于所选路径，再读取其前后有限条真实 Entry；若暂时无法确定下行路线，则仅取 anchor 和向上的祖先窗口（`after=0`），直到用户选定后续路径才能向下加载。一个节点有多条实际 User 后续而未指定阅读路线时，服务端应返回可选直接分支元数据供客户端显示选择器，绝不能自行按 `seq` 或最近时间猜测。消息定位/切换阅读路径不调用 `select-leaf`，只有明确继续交互才更新 `active_leaf_entry_id`。

全局树允许加载完整树元数据或按子树分页，但树布局不依赖把所有 `content` 正文一次性取回。对大量节点的统计可按需缓存，缓存不是权威数据。

## 同步事务与历史压缩数据

- 世界卡同步使用一次短事务：将已发布 `worlds.published_json`、`worlds.version` 分别复制为实例 `sessions.world_snapshot_json`、`sessions.source_world_version`，可更新 `updated_at`；禁止使用未发布草稿或触碰 Entry 树、分叉关系、已有状态快照或已选交互叶子。若启用了 `data.state`，同步前必须检查新旧状态定义的兼容性，不兼容时拒绝隐式启用并提示显式迁移。
- `context_checkpoints` 在历史压缩阶段引入，最小持久化字段包括 `id`、`session_id`、`anchor_entry_id`、摘要文本、用于有效性检查的世界快照/Context 指纹及时间。具体 DDL 等待 Pi 接入与压缩可行性验证。
- 检查点仅对**锚点在当前叶子祖先链**上的路径有效。编辑历史节点 X 后，对覆盖 X 内容的检查点（锚点为 X 或其后代）标记失效或重新计算；严格位于 X 之前的检查点仍可有效。原始消息保留可分页；未来记忆与状态遵循类似的祖先隔离规则。

## 备份、迁移和回退

数据库位于独立数据目录，不覆盖世界卡原始素材。迁移失败应停止写入并保留可用的旧数据库；运行中使用 SQLite 的一致性备份能力或经过验证的快照备份，不依赖简单复制 WAL 运行时主文件。普通导出不含密钥，恢复不应悄悄覆盖现有用户故事。

## 数据验证

- 两段世界版本与 Session 唯一来源版本；同步不改变消息、分叉关系、已有状态快照和交互叶子；不兼容状态定义不直接生效。
- 应用层同实例引用校验、父子无环、唯一根约束、并发 `seq` 分配；在历史 User 处发起分叉，新增其父 AI 的 User 子节点，不超过 3 条；重复请求幂等且不会误建第四分支。
- 按指定阅读叶子双向游标分页和围绕任意 Entry 直接读取窗口，服务端校验锚点在路径上；没有确定后续路线时只读祖先，遇到多路分叉须显式选择，不能混入兄弟分支；1000 轮长历史按需加载。
- 切换阅读路线只修改客户端 `view_leaf_entry_id`，历史跳转与滚动不影响持久化 `active_leaf_entry_id`；用户明确选择「在此世界线继续」才切换交互叶子。
- 取消/失败恢复、服务重启、不同叶子的压缩可见性；仅末尾 AI 可重生成/续写，编辑历史不自动生成后代且派生上下文失效；消息删除接口不存在，迁移回滚后数据一致。
- 状态功能验证：不同 Opening 的初始值整字段覆盖；User 继承、AI 结算、无变化仍完整快照；`set/add/insert/delete/move` 合法性及不可删除顶层字段；同一 AI 消息重算幂等；分支间状态隔离；历史编辑后 `stale`；不兼容世界卡同步拒绝无声迁移。
