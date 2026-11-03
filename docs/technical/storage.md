# Storage：Run/Message 树、预设、模型选择与状态快照

> 2026-11-03 目标设计，尚未执行迁移；SQLite 仍是**唯一持久化权威来源**。本文件只定义数据表、事务、索引与 API 存储契约，领域规则见 [Session](../design/session.md)、[Preset](../design/preset.md)、[Provider](../design/provider.md)、[WorldInstanceContext](../design/world-instance-context.md)、[State](../design/state.md)。

## 1. 总体存储边界

**Run 是会话树的基本节点，Message 是 Run 内有序的内容**；Run 负责父子关系、世界线、分页游标、完整状态快照和一次 AI 结算，Message 不再含 parent_entry_id，也不独立定义会话分叉。Opening 是带一条 Assistant Message 的 Root Run；普通 Run 是 User + 可选已完成 Assistant Message。工具调用日志不作为聊天 Message，Pi JSONL/SessionManager 不成为数据库外的第二套权威历史。

保持当前 MVP 的轻量数据库原则：统一服务层检查引用关系、父链环/跨 Session 关系、Run 限额与权限；所有跨表写入必须在**短 SQLite 事务**中完成，不能使用级联删除来代替产品删除规则（首期不提供消息/Run 删除）。DDL 与 SQLite 驱动在落地阶段冻结。

## 2. 逻辑数据表

| 表 | 关键字段 | 权威职责 |
| --- | --- | --- |
| `worlds` | `id, name, draft_json, published_json, version, created_at, updated_at, published_at` | 世界卡当前草稿/最新发布 |
| `sessions` | `id, world_id, world_snapshot_json, source_world_version, world_snapshot_revision, title, opening_id, user_character_id, user_character_snapshot_json, preset_id, model_selection_json, context_options_json, context_options_revision, state_definition_json, state_schema_hash, active_leaf_run_id, run_tree_revision, run_content_revision, created_at, updated_at` | 一个世界实例、选中身份、Preset、模型选择、冻结 Schema、唯一活动叶子及必要并发修订 |
| `runs` | `id, session_id, parent_run_id, seq, kind, status, user_request_id?, generation_id?, state_snapshot_json?, state_changes_json?, state_status?, state_schema_hash?, state_revision?, parent_state_revision?, last_error_code?, created_at, updated_at` | 一次 Opening 或互动回合；完整状态逻辑快照与树关系 |
| `messages` | `id, run_id, ordinal, role, content, raw_content?, revision, created_at, updated_at` | Run 内玩家可见 User/Assistant 内容，`(run_id, ordinal)` 唯一 |
| `run_tool_calls` | `id, run_id, generation_id, tool_call_id, name, arguments_json?, result_json?, status, created_at, updated_at` | 只记录 Pi 工具调用的受限内部执行事实，和玩家可见 Message 分离 |
| `presets` | `id, name, description, is_builtin, schema_version, revision, config_json, created_at, updated_at` | 完整、有序节点数组与预算策略；不可删除默认预设 |
| `provider_credentials` | `provider_id, credential_ref, updated_at, last_verified_at?, status` | 仅指向独立安全存储，不存 API Key 明文 |
| `app_settings` | `key, value_json, updated_at` | 默认 `model_selection` 等少量持久配置 |
| `tags / world_tags` | 同原有语义 | 世界卡搜索/标签，不影响 Prompt 或 Run |
| `schema_migrations` | `version, applied_at` | 数据库结构迁移记录 |
| `context_checkpoints`（以后） | `session_id, anchor_run_id, summary_json/text, source_hash, created_at` | 可选历史压缩摘要；仅使用锚点 Run 的真实祖先链 |

**不建立**用户自定义 `providers` 或 `models` 表。支持的供应商/模型由锁定版本的 Pi 内置模型目录提供，ProviderService 只做产品允许列表、模型选择/能力查询及用户 API Key 管理；`sessions.model_selection_json` 仅保存 `{provider, modelId}`（及普通生成参数）。`provider_credentials` 如需在 SQLite 保存，仅保存安全凭据引用/脱敏配置，实际 Key 由注入 Pi 的 CredentialStore 安全保存。世界线从 Run 元数据按需计算，MVP 不建 WorldInstanceContext 或拓扑缓存。

## 3. Run、Message 约束与状态

- 每个 Session 一个 Opening Root Run（`kind=opening, parent_run_id=null`），其 Message 唯一 `ordinal=0 role=assistant`，初始状态由冻结强类型 `state_definition_json` 与 Opening 覆盖创建。
- 普通 `kind=turn` 必须有同 Session 的 `parent_run_id`，第 0 条 Message `role=user`；如果已生成，第 1 条 Message `role=assistant`。`runs.status=awaiting_ai` 表示只有 User，`completed` 表示叙事已提交。不要把模型生成中间流式 token 当成已完成 Message。
- 一个父 Run 最多 3 个直接 child Run，必须在并发创建事务内检查并分配 `seq`；唯一 Request ID/模型 generation ID 保护重试，`seq` 只代表分配顺序不能用于祖先拼接。
- 每个已保存 Run **逻辑上保存完整** `state_snapshot_json`，直接对应 `state_definition_json.modules` 的运行值顶层键，无 `world/user` 包装；`awaiting_ai` 继承父快照，`completed` 结算受限 ChangeSet。状态可为 `success/inherited/missing/invalid/stale`；状态失败不得作为已结算结果继续生成。
- Tool Call 产生时按 `(run_id, generation_id, tool_call_id)` 幂等持久化 `run_tool_calls` 事件/最终状态，包含允许存储的脱敏参数及结果；取消或失败的工具调用记录可保留以供诊断，但**不得**被当成已结算状态或玩家可见消息。结果与参数需有大小限制和隐私过滤；模型下一轮以真实 User/Assistant 父链和已结算状态为准，不把失败工具输出当故事事实。
- 当前只持久化 `completed` 的可见 AI 正文；如果 AI 正文成功而状态更新失败，可保存 Assistant Message 但设置 Run `state_status=invalid/missing`，明确需要修复。取消/网络故障保持 Run `awaiting_ai` 和 User Message，允许对**同一 Run**重新生成。
- `messages.raw_content` 保存原始模型输出（若有）但必须限制访问，不回注历史；`run_tool_calls` 保存工具的受限诊断记录，普通 SSE token delta 和 Pi 全量内部 Trace 不逐条落库，也不伪造额外 Assistant/Run。

## 4. Preset 与模型配置

`presets.config_json` 保存所有七系统节点及自定义文本节点的**完整有序 `nodes[]`**、Budget 与 `scan_depth_runs`，而不是已展开的 Prompt。`builtin/default` 有稳定 ID，允许编辑但不删除；`revision` 防止并发覆盖。导入/导出只针对可移植配置，不带密钥、运行历史、具体模型绑定。

模型选择优先当前 `sessions.model_selection_json`，没有则读取 `app_settings.default_model_selection_json`；Preset 不包含 model/provider。ProviderService 从 Pi 内置模型目录校验 model ID 与所需凭据是否已配置；真实 API 仍由 Pi 调用，不维护每 Provider HTTP Adapter。`provider_credentials.credential_ref` 引用 OS 凭据管理/专门的安全密钥存储，不在 SQLite 明文持有 API Key。Credential 读取 API 只返回配置状态，禁止回显。

## 5. 会话快照与并发版本

`sessions.world_snapshot_json` 是本局权威世界卡内容；仅显式同步时更新快照及 `world_snapshot_revision`。下一轮 `loadWorldInstanceContext` 直接重新读取 Session，**无需 Context 缓存失效框架**。`context_options_json` 保存本局手动世界书选择、状态更新模式 `state_update_mode` 等会话配置；如果保留 `context_options_revision`，用途只是并发编辑保护，不是 Context 缓存版本。

`run_tree_revision` / `run_content_revision` 可以保留用于 UI 变化通知与乐观并发，但世界线初期按 Run 元数据重新计算，不增量维护缓存。切换活动叶子只改变指针并更新 Chat 游标绑定；`messages.revision` 用于乐观并发编辑。正在执行的本轮冻结父 Run/Schema/预设/模型的必要值，最终以 Run/generationId 与必要修订校验拒绝迟到结果。

## 6. 事务与并发

### 创建 Session

一次事务完成世界/Opening/角色许可校验、保存发布世界 JSON 与玩家角色快照、冻结 Schema/hash、创建 Opening Root Run+Assistant Message+完整初始状态、设置 `active_leaf_run_id`。失败不得出现只有 Session 而没有 Root Run 的部分记录。

### 发送 User

检查 `expected_active_leaf_run_id` 是同一 Session 的真实叶子且状态有效，使用幂等 `client_request_id` 原子创建 child Run `awaiting_ai`、User Message 与继承快照，更新活动叶子和 `run_tree_revision`；外部模型调用在事务之外执行。

### AI 完成

固定 Run ID、父状态 revision、Schema hash、model/preset/world snapshot 版本和 generation ID；在独立状态引擎中验证整个 ChangeSet 和最终完整快照。在短事务内检查 Run 仍为可提交的 `awaiting_ai`、活动叶子、generation 幂等与版本一致，追加 Assistant Message（`ordinal=1`）并更新本 Run 状态；不能额外建 Run，也不能在另一条世界线上提交迟到结果。失败保持可诊断状态，不部分提交状态变化。

### 编辑与分叉

编辑 Message 检查 `expected_revision`，不删除后代；受影响的 Run 和后代状态标记 stale，其他分支保持有效（共享祖先编辑时所有经过它的分支均受影响）。历史 Run 分叉按 **旧 Run 的父 Run** 作为新 Run parent，检查子节点不超过 3，继承那个父 Run 的状态。切换活动叶子验证同 Session、真实叶子、`expected_active_leaf_run_id`，只更新指针与 UI 导航绑定，不修改历史。

## 7. Run 级分页与世界线存储 API

| 接口 | 语义 |
| --- | --- |
| `GET /sessions/:id/runs?limit=30` | 当前活动叶子向上取最多 30 **Run**，每个 Run 携带自己的完整可见 Messages |
| `GET /sessions/:id/runs?leaf_run_id=R&before_run_id=X&limit=30` | 只从 X 的真实 parent_run_id 继续向上；验证 X 是 R 祖先和 R 仍是活动叶子 |
| `GET /sessions/:id/worldlines` | 只返回 Root/Fork **可见 Run** 与压缩边；边按 Run 计数并带终止 `leaf_run_id` |
| `PUT /sessions/:id/active-leaf` | 原子切换真实叶子 Run；不允许中间节点变活动叶子 |
| `POST /sessions/:id/runs` | 在当前真实叶子下提交新 User Run，附幂等 request ID |
| `POST /sessions/:id/forks` | 指定历史 Run、从其父 Run 新建兄弟 Run 并提交新 User |
| `PATCH /sessions/:id/messages/:message_id` | 修改可见消息正文，按依赖范围标记状态 stale；不删后代 |
| `POST /sessions/:id/runs/:run_id/retry` | 同一 `awaiting_ai` Run 重新请求生成 |

分页必须按 Run 父链取 `limit+1` **个 Run** 检测是否还有祖先，再批量读取这些 Run 的全部可见 Messages，按祖先旧到新及 ordinal 排序。不能用 Message LIMIT=30、不能用全局 Run seq 减法、不能以 UI 最近一页代替 AgentContext 历史。游标应绑定 `leaf_run_id + run_tree_revision`（或一致性读取的预期活动叶子），跨世界线切换拒绝旧游标；同线生成更新绑定并保留已读取祖先。

压缩图构建从 Run 的 `id/parent_run_id/status` 和少量预览字段推导；只保留 Root/Fork 真实节点，不返回可见 Leaf 或 Branch Start 节点。终止边用 `terminal_leaf_run_id` 指向真实叶子，`collapsed_run_count` 包括终止边内被折叠的叶子 Run；非终止边只数两个可见端点之间的隐藏 Run。大树不静默截断，支持子树查询与 `has_more`。不依赖已缓存的拓扑作为事实来源。

## 8. 备份、迁移与验收

采用 SQLite 一致性备份（不能只复制活动 WAL 的主数据库文件），数据库迁移失败停止写入、保留旧文件，不重写任何私人聊天原始历史。由于当前尚在设计阶段，旧 Entry 方案不视为已运行的数据；如已有测试数据，须先备份并提供 **Entry→Run/Message** 的显式转换预览，保证每个 Opening 和 User/Assistant 配对正确、旧父链能映射到 Run 树；不能仅重命名 `entries` 表。移除旧 API 需要同步更新前端与所有示例，不保留无声兼容。

必须验收：一次普通 Run 内 User+Assistant 持久化；`limit=30` 返回 30 Run 而不是 30 Message；运行失败后同 Run 重试；Run 子数上限；跨分支读写隔离；Root/Fork-only 压缩边计数；状态幂等/版本冲突；Provider Key 不落世界卡/日志/预设。
