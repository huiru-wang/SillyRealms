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
| `entries` | `id` 主键、`session_id`、`parent_entry_id` 可空、`seq`、`role`、`content`、`status`、`fork_reason` 可空、`created_at` | 有父子关系的真实用户/AI 消息；`seq` 只代表创建顺序，不用于历史游标 |
| `branch_options` | `id`、`session_id`、`fork_entry_id`、`slot`（1～3）、`title`、`instruction`、`first_entry_id` 可空、`created_at`、`updated_at` | 分叉阶段引入：已完成 AI 分叉点的规划路线和实际入口，最多 3 个槽位；未开启选项不产生 Entry |

世界卡内容发布、版本递增与手动实例同步的业务语义以[世界卡领域设计](../design/world-card.md)为准；本表只存 `worlds.version` 与实例单个 `source_world_version`，同步事务更新 JSON 快照与来源版本，不影响树或选项。

首期 `entries.role` 只要求用户/AI 可见消息；`status` 区分生成中、完成、失败/中断，内建工具事件需要未来单独持久化和恢复。普通消息形成单链，但底层始终使用父子指针，路径分页参见下文「一致性、索引和分页」；完整分叉选项及压缩检查点的存储可分期增加。导入原始角色卡数据单独保留时，不视作已转换完成的世界内容。

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

首期**不设计** `world_assets`、`entry_attachments`、`models`、`memories`、`state_checkpoints`、独立 `branches` 或 `runs` 表；`branch_options` 由分叉交互阶段启用，`context_checkpoints` 由压缩阶段按 Entry 锚点引入。即使后续支持分叉也不增加并行的 `branches` 消息表。世界卡中的资源引用可以保留，但资源文件管理不在本表设计范围。

## 一致性、索引和分页

主要索引：`entries(session_id, seq)` 唯一，`entries(session_id, parent_entry_id)` 读取子节点；分叉阶段增加 `branch_options(session_id, fork_entry_id, slot)`（同时保证 `(fork_entry_id, slot)` 唯一）；`sessions(world_id, updated_at)` 用于世界下的实例列表；标签索引维持原设计。主键和索引不属于外键。

所有引用由服务层校验：写入消息前确认会话存在；创建会话时确认世界已发布、预设和 API 连接可用；修改或删除世界、预设、连接和对象标签时检查相关引用并采取用户可见的保留、解除或拒绝策略，不留悬空引用。多项关联写入在短事务中完成；并发更新使用事务和应用层冲突检查。禁止用数据库外键或级联删除替代这些规则。

打开会话先定位有效 `active_leaf_entry_id`，只读取该叶子的最近一页祖先消息；历史游标使用固定 `leaf_id` 与 `before_entry_id`，沿 `parent_entry_id` 递归查询并验证游标确实属于所选路径，绝不能用 `(session_id, seq)` 获取分叉历史。每次新增消息仍须在短事务中获得唯一递增 `seq`，并校验同实例父节点、非环和最多 3 路约束。H5 同时限制渲染数量并保持上滑位置。

## `branch_options` DDL 与校验

```sql
CREATE TABLE branch_options (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  fork_entry_id TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  first_entry_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (fork_entry_id, slot),
  UNIQUE (first_entry_id)
);

CREATE INDEX idx_branch_options_fork
ON branch_options (session_id, fork_entry_id, slot);
```

数据库层使用 `slot BETWEEN 1 AND 3` 和唯一索引约束槽位；服务层事务必须校验 fork Entry 属于同一 session、类型是已完成 AI、`first_entry_id` 是该 fork 的直接子 Entry、无环且同一个子节点不被两个选项引用。同步检查真实子节点总数 ≤3；不能因为没有外键而漏掉逻辑约束。已有正常后续占用槽位的业务规则见[会话](../design/session.md)。

## 查询与 API 草案

| 接口 | 语义 |
| --- | --- |
| `GET /sessions/:id/tree` | 返回扁平 Entry `id/parent_entry_id/role/status/preview`、分叉原因、选项状态与树统计，按需展开子树 |
| `GET /sessions/:id/entries?leaf_id=...&before=...&limit=...` | 固定叶子祖先路径的游标分页；按阅读顺序返回 |
| `POST /sessions/:id/fork-points/:ai_entry_id/options` | 设置共同分叉原因、创建/维护不超过 3 个选项，处理已有原路线登记 |
| `POST /sessions/:id/options/:option_id/start` | 幂等地首次开启选项并开始 Agent 生成 |
| `POST /sessions/:id/select-leaf` | 校验并更新当前选中叶子 |
| `POST /sessions/:id/generate` | 明确指定起始叶子及本次操作；正常消息、续写、恢复、重生成受统一分叉约束 |
| `POST /sessions/:id/compact` | 对指定叶子路径创建/更新派生压缩摘要，不改写 Entries |

**历史游标**必须包含本次固定的 `leaf_id` 与 `before_entry_id`（或签名游标）；按 `parent_entry_id` 逐层取祖先，每次只获取所需页并反转为时间阅读顺序。服务端检查游标确实属于指定叶子的祖先链，不能使用全实例 `(session_id, seq)` 过滤后假装分页。首屏优先查询最近一页，向上翻页返回更早祖先，避免打开长篇故事时加载所有节点。查询须设置合理的分页上限并防御异常循环。

全局树允许加载完整树元数据或按子树分页，但树布局不依赖把所有 `content` 正文一次性取回。对大量节点的统计可按需缓存，缓存不是权威数据。

## 同步事务与历史压缩数据

- 世界卡同步使用一次短事务：将已发布 `worlds.published_json`、`worlds.version` 分别复制为实例 `sessions.world_snapshot_json`、`sessions.source_world_version`，可更新 `updated_at`；禁止使用未发布草稿或触碰 Entry 树/选项。
- `context_checkpoints` 在历史压缩阶段引入，最小持久化字段包括 `id`、`session_id`、`anchor_entry_id`、摘要文本、用于有效性检查的世界快照/Context 指纹及时间。具体 DDL 等待 Pi 接入与压缩可行性验证。
- 检查点仅对**锚点在当前叶子祖先链**上的路径有效。原始消息保留可分页；失效的摘要可删除并重建。未来记忆与状态遵循类似的祖先隔离原则。

## 备份、迁移和回退

数据库位于独立数据目录，不覆盖世界卡原始素材。迁移失败应停止写入并保留可用的旧数据库；运行中使用 SQLite 的一致性备份能力或经过验证的快照备份，不依赖简单复制 WAL 运行时主文件。普通导出不含密钥，恢复不应悄悄覆盖现有用户故事。

## 数据验证

- 两段世界版本与 Session 唯一来源版本；同步不改变消息和选项。
- 应用层同实例引用校验、父子无环、唯一根约束、并发 `seq` 分配、选项 1～3 槽、原有路线占槽、重复请求幂等，阻止第 4 条分支。
- 按选定叶子查询最近一页及更早游标，仅沿祖先链，不把兄弟路线混进 Context；1000 轮长历史按需加载。
- 取消/失败恢复、服务重启、不同叶子的压缩可见性，及迁移回滚后的数据一致性。
