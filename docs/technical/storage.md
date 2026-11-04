# Storage：六表、Run 游标与完整 Pi Entries

> 2026-11-04 目标方案，尚未实现。以六张业务表支撑世界卡、预设、Session 和真实 Agent 历史。**entries 一行一条消息/技术记录；run_id 把一次逻辑交互的多条 Entry 分组供游标分页；parent_id 确定分叉。** 参见 [Session](../design/session.md)、[Context Strategy](../design/context-strategy.md)。

## 1. 六表职责

| 表 | 核心字段 | 含义 |
| --- | --- | --- |
| worlds | id/name/data_json/created_at/updated_at | 唯一当前 WorldCard，含 lorebook、角色、Opening、状态定义与 window/summary 策略 |
| presets | id/name/config_json/is_builtin/created_at/updated_at | 模型、生成参数、Token 预算、摘要 Prompt、节点编排 |
| provider_credentials | provider_id/credential_ref/updated_at | 密钥安全存储引用，Key 本体在 CredentialStore |
| tags | id/type/name/sort_order/created_at | 按 type 排序的标签字典 |
| sessions | id/world_id/preset_id/user_character_id/tip_entry_id/title/created_at/updated_at | 会话关系和当前分支真实末尾 |
| entries | id/session_id/parent_id/**run_id**/seq/type/role/sub_type/timestamp/payload | Raw Pi Message 和技术 Entry；Run 分页、Entry 分叉 |

不建独立的 `runs`、`messages`、`tool_calls`、`world_tags`、`app_settings`、`context_checkpoints` 表。Session 不保存 `world_snapshot_json`、`opening_id`、`model_selection_json`、`options_json`、`runs_json` 或 `selected_run_id`。世界卡直接引用当前版本；Schema 不兼容时允许状态重置。

## 2. SQLite DDL

~~~sql
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE provider_credentials (
  provider_id TEXT PRIMARY KEY,
  credential_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(type, name)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  preset_id TEXT NOT NULL REFERENCES presets(id),
  user_character_id TEXT NOT NULL,
  tip_entry_id TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (
    type IN ('message', 'compaction', 'branch_summary', 'custom')
  ),
  role TEXT,                            -- 仅 message 有值，供 SQL 直接按角色查询
  sub_type TEXT,                        -- 仅 custom 有值，Pi customType 的持久化映射
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(session_id, seq),
  CHECK (
    (type = 'message' AND role IS NOT NULL AND role IN ('user', 'assistant', 'toolResult'))
    OR (type <> 'message' AND role IS NULL)
  ),
  CHECK (
    (type = 'custom' AND sub_type IS NOT NULL AND length(sub_type) > 0)
    OR (type <> 'custom' AND sub_type IS NULL)
  )
);

CREATE INDEX idx_entries_parent ON entries(session_id, parent_id);
CREATE INDEX idx_entries_run ON entries(session_id, run_id, seq);
CREATE INDEX idx_entries_role ON entries(session_id, role, seq);
CREATE INDEX idx_tags_type_sort ON tags(type, sort_order, name);
~~~

开启 `PRAGMA foreign_keys=ON`，使用 `PRAGMA user_version` 管理迁移版本；SQLite JSON 以 TEXT 保存，领域层校验具体 Entry payload、跨 Session parent_id/tip_entry_id、摘要 coveredThroughEntryId 是当前祖先等不变量。全局 `seq` 在一个短写事务中按 Session 分配唯一递增值；**seq 只是写入顺序，不等于某条分支的历史顺序**。MVP 不设计分布式锁、Run 实体表或多版本快照表。

## 3. entries.type 与 payload 的准确关系

| type | 何时出现 | payload / 限制 |
| --- | --- | --- |
| `message` | Pi 完整 User / Assistant / ToolResult 消息 | `message: PiMessage`；实际角色在 `message.role`，ToolCall 是 Assistant 的 content 块 |
| `compaction` | Pi SDK 原生上下文压缩 Entry（MVP 不主动使用） | 按当前锁定 Pi SDK 的原生 compaction payload 保存 |
| `branch_summary` | Pi SDK 原生分支摘要 Entry（MVP 不主动使用） | 按当前锁定 Pi SDK 的原生 branch_summary payload 保存 |
| `custom` | SDK 或产品自定义技术 Entry | `sub_type` 必填，payload 按自定义类型校验；内部摘要标记 `sillyrealms.summary` |

**没有 `type='summary'`，也没有 `type='user'/'assistant'/'toolResult'`。** 这两层类型不能混为一谈。四类 Entry 与 Fanto 使用的 Pi Session Entries 保持一致；本项目的 Summary 策略不是 SDK 原生 compaction，用 `sub_type=sillyrealms.summary` 表示。

~~~ts
type MessageEntryPayload = {
  message: PiMessage;                  // user/assistant/toolResult
  stateSnapshot?: StateSnapshot;       // 最终有效 Assistant 才能有
  stateChanges?: StateChange[];        // reason 必填
  stateReset?: boolean;
  origin?: "pi" | "derived_tool_narrative";
};

type SummaryCustomPayload = {          // type=custom, sub_type=sillyrealms.summary
  summary: string;
  coveredThroughEntryId: string;
  generation: Array<{
    requestMessages: PiMessage[];
    responseMessages: PiMessage[];
  }>;                                  // 摘要调用过程也完整落库
};
~~~

正常 Pi 主轮产生的每条已完成 user/assistant/toolResult Message 都按原样**分别**写 Entry；Assistant 中 toolCall/thinking 不能丢失，ToolResult 不能省略。SDK 其它技术 Entry 若实际产生也要持久化。SSE 逐 token delta 不属于完整 Message，无需逐 token 落库。

**消息角色快速查询**：`role` 是 `payload.message.role` 的可索引冗余列，仅 `type=message` 才有值，写入/恢复必须与 payload 一致并在应用层校验；用户历史/Context 先在当前世界线祖先链上筛选 `role IN ('user','assistant')`，再用 NarrativeProjection 去除 Assistant 的 toolCall/thinking/状态协议。**绝不能只用 role 过滤全 Session 而串入旁支**。SQLite 允许对 `role` 加约束，不以额外 role 替代 Pi 原始 payload。

## 4. Run 关系、游标查询和分叉

- 每次玩家发送生成新的 `run_id`；同轮 Summary Custom Entry、User、Assistant/ToolResult/后续 Assistant 共用这个 ID。创建 Session 时 Opening 也有一个独立初始化 run_id。
- Assistant 重新生成属于原 User 的**同一逻辑 Run**，分叉数据通过 parent_id 辨别；编辑 User 生成新的兄弟 User，属于**新 Run**。
- `getRunPage` 先沿 `sessions.tip_entry_id` 的 parent_id 得到**当前分支祖先链**，再按 run_id 分组，按每个 Run 在当前分支最早 `MIN(seq)` 倒序选 `limit` 个 Run；再读取这些 Run 的**全部祖先 Entry**（`seq ASC`）。
- 游标 `nextCursor` 是该页最老 Run 的 `run_start_seq`；下一页只选 `run_start_seq < cursor`。limit 计 **Run 而非消息/Entry**，例如一次用户交互输出了 1 条 User、3 条 Assistant、2 条 ToolResult，也是一页额度中的**一个 Run**。
- **不能先按 run_id 全 Session 查再筛世界线**。相同逻辑 Run 可能有多个 Assistant 备选分支；必须先筛父链，只读取当前选择的那一条路径。切换 tip 后客户端清空旧游标。
- `getChatPage` 使用同一批 Run 结果再做 NarrativeProjection，仅展示 user/assistant 叙事。Raw Run 页面则可返回 ToolCall/ToolResult/技术 Entry 供内部调试。
- 最近 State Snapshot 和摘要覆盖边界都沿真实祖先读取，与按 Run 分页及按 Token 缩短 Prompt 无关。

### 世界卡的级联删除与资产边界

- `deleteWorld(worldId)` 是**彻底删除**：前端明确二次确认；服务端先阻止该世界新增 Session/Run、停止并等待在途运行退出，收集世界与各 Session 的本地独占资源目录。
- 在一个 SQLite 事务中 `DELETE FROM worlds WHERE id=?`，由 `sessions.world_id ON DELETE CASCADE` 和 `entries.session_id ON DELETE CASCADE` 删除**全部会话、全部分支、全部 Run/消息/技术 Entry**；摘要、状态快照随所在 Entry 一起删除。也可显式按依赖顺序删除，但不可留孤儿记录。
- 资产资源采用可核验的**世界/Session 独占命名空间**：世界卡 `assets[]` 和会话附件属于其拥有者；引用同一文件的多个世界必须使用共享资源管理/引用计数或独立拷贝，**绝不删仍被其它 World 使用的文件**。外部 HTTP 链接只移除引用，不远端删除。无独立资源业务表时，磁盘资产路径/清单需有可恢复的清理规则。
- 为防止数据库已提交而文件删除失败，先把要删除的独占目录原子移到隔离待清理区（失败回滚），事务提交后清理隔离区；清理失败由下次启动的幂等回收重试并记录错误，不能宣称已完成物理文件清理。Session 单独删除采用同样机制。全局 Preset、Provider Key、Tag 不属于该世界，保持不变。

## 5. 世界状态、配置与运行次序

- Session 创建 = 短事务写 Session + 初始化 Run + 根 Assistant Opening Entry（带 S0），设置 tip。
- 普通运行 = 读取分支/状态 → [Context Strategy](../design/context-strategy.md) 预检查 Token（必要时先摘要）→ 短事务写同一 run_id 的 Summary（如果生成）和 User → Pi 产生的消息依序写 Entry → 最终成功 Assistant 附完整新 State。
- 当只收到 `submit_turn.narrative` 而没有最终叙事正文时，将其规范化为独立 Assistant Message Entry，`origin=derived_tool_narrative`；原始 ToolCall 与 ToolResult 保留。
- `presets.config_json.budget` **仅**保存 `max_context_tokens?` 与 `max_output_tokens`；内部固定 Token 估算余量不向前端或持久化配置开放。实际输入上限 `min(预设上限, 模型 contextWindow) - 输出预留 - 内部估算余量`。WorldCard `data.context.strategy` 只有 window/summary，默认 window；`max_messages` 是条数阈值，不是 Token 阈值。
- 旧状态 Schema 与当前 WorldCard 不兼容，允许重新初始化 State；以前的消息/快照不删除。Key 不进入 WorldCard/Session/Preset 导出。
- `tags` 的类型内稳定排序通过 `ORDER BY sort_order, name, id` 实现；WorldCard.data.tags 仅存 type=world 标签 ID 数组。

## 6. 验收

- DDL 在 SQLite 内存环境执行，只有六张业务表；Entry 四类 enum、sub_type/role 条件、run_id NOT NULL 与索引正确。
- run_id 成组分页不丢同轮 Entry，也不混入另一个分支同 run_id 的回复；Opening、摘要都有 run_id。
- 消息原样入库、UI/下轮 Prompt/关键字用统一叙事投影；Token 窗口和摘要不修改 Raw History。
- 状态不依赖上下文裁剪，所有合法变更含 reason 和有效完整快照；模型/世界卡/角色关联与更新规则一致。