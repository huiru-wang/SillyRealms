# Storage：六表、Run 游标与完整 Pi Entries

> 2026-11-04 目标方案，尚未实现。以六张业务表支撑世界卡、预设、Session 和真实 Agent 历史。**entries 一行一条消息/技术记录；run_id 把一次逻辑交互的多条 Entry 分组供游标分页；parent_id 确定分叉。** 参见 [Session](../design/session.md)、[Context Strategy](../design/context-strategy.md)。

## 1. 六表职责

| 表 | 核心字段 | 含义 |
| --- | --- | --- |
| worlds | id/name/data_json/state/created_at/updated_at | 唯一当前 WorldCard，含 lorebook、角色、Opening、状态定义与 window/summary 策略 |
| presets | id/name/config_json/is_builtin/created_at/updated_at | 模型、生成参数、Token 预算、摘要 Prompt、节点编排 |
| provider_credentials | provider_id/credential_ref/updated_at | 密钥安全存储引用，Key 本体在 CredentialStore |
| tags | id/type/name/sort_order/created_at | 按 type 排序的标签字典 |
| sessions | id/world_id/preset_id/user_character_id/tip_entry_id/title/state/created_at/updated_at | 会话关系和当前分支真实末尾 |
| entries | id/session_id/parent_id/**run_id**/seq/type/role/timestamp/payload/state/ext_data | Raw Pi Message 和技术 Entry；Run 分页、Entry 分叉 |

不建独立的 `runs`、`messages`、`tool_calls`、`world_tags`、`app_settings`、`context_checkpoints` 表。Session 不保存 `world_snapshot_json`、`opening_id`、`model_selection_json`、`options_json`、`runs_json` 或 `selected_run_id`。世界卡直接引用当前版本；Schema 不兼容时允许状态重置。

## 2. SQLite DDL

~~~sql
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state) AND json_type(state) = 'object'), -- 世界卡级 Global
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
  state TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(state) AND json_type(state) = 'object'), -- Session 级
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
    type IN ('message', 'compaction', 'branch_summary')
  ),
  role TEXT,                            -- 仅 message 有值，供 SQL 直接按角色查询
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  state TEXT CHECK (state IS NULL OR (json_valid(state) AND json_type(state) = 'array')),
  ext_data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ext_data) AND json_type(ext_data) = 'object'),
  UNIQUE(session_id, seq),
  CHECK (
    (type = 'message' AND role IS NOT NULL AND role IN ('user', 'assistant', 'toolResult'))
    OR (type <> 'message' AND role IS NULL)
  )
);

CREATE INDEX idx_entries_parent ON entries(session_id, parent_id);
CREATE INDEX idx_entries_run ON entries(session_id, run_id, seq);
CREATE INDEX idx_entries_role ON entries(session_id, role, seq);
CREATE INDEX idx_tags_type_sort ON tags(type, sort_order, name);
~~~

开启 `PRAGMA foreign_keys=ON`，使用 `PRAGMA user_version` 管理迁移版本；SQLite JSON 以 TEXT 保存，领域层校验具体 Entry payload、跨 Session parent_id/tip_entry_id、摘要 coveredThroughEntryId 是当前祖先等不变量。全局 `seq` 在一个短写事务中按 Session 分配唯一递增值；**seq 只是写入顺序，不等于某条分支的历史顺序**。MVP 不设计分布式锁、Run 实体表或多版本快照表。

## 3. Entry 的 payload、state 与 ext_data

`payload` 参考 Fanto 的 `apps/server/src/agent/checkpoint/codec.ts`：不重复保存 id、parent_id、seq、type、timestamp 等列，只保存对应 Pi Entry 的原生内容字段。Fanto 本身支持 custom；本项目明确不存 custom，不能声称完整兼容其全部 Entry 类型。

| type | payload |
| --- | --- |
| `message` | `{message: PiMessage, terminate?: ...}`；role 与 `message.role` 一致 |
| `compaction` | `{summary, retainedTail, tokensBefore, details?, usage?, fromHook}`，保持 SDK 原生格式 |
| `branch_summary` | `{fromId, summary, details?, usage?, fromHook}`，保持 SDK 原生格式 |

`state` 独立保存一个 JSON 数组，元素为 `{ "key": "根模块名", "value": <该根模块完整运行值> }`，每个 key 唯一；空状态为 `[]`。例如：

```json
[{"key":"世界","value":{"时间":"夜晚"}},{"key":"清月","value":{"心情":"放松","灵力":80}}]
```

此数组是该 Entry 当前分支的**一份最新完整状态**，不是变更历史或多个版本的快照数组。按 key 还原成对象后，以 Lodash 路径 `清月.心情` 访问并按对应 Schema 校验；编码时按定义中的根模块顺序输出。`NULL` 表示本 Entry 没有保存状态，并非空状态；沿父链向上找最近非 NULL 的有效 Message state，`[]` 表示明确的空状态。Opening 和成功结算的最终 Assistant 写完整 state；User、ToolResult、中间 Assistant、摘要等通常为 NULL，不覆盖父状态。历史 Entry 各自保留其当时状态，以支持分叉与重生成；不维护单独 snapshot 字段或版本数组。

Global 状态存在 `worlds.state`，按 world ID 隔离，所有关联 Session 共享；Session 状态存在 `sessions.state`，仅所属 Session 的分支共享。两列均为完整 JSON 对象，不与世界卡 `data_json` 定义混存。世界卡创建时初始化 Global，会话创建时初始化 Session；创建会话和重新生成不得重置 Global。世界卡首页读取对应 Global 最新已提交值，不依赖 Session。Session/Message 引用在无会话的首页不可用并返回诊断。

Run 开始从三个作用域已提交值复制完整工作状态；when 只读初始值，Prompt 脚本 setState 按顺序校验并更新工作状态，模型仅对 Message 工作状态应用部分变更。跨 scope 同一批变更在同一 SQLite 事务中核对读取版本并一起提交，冲突时整批失败并提示重试；预览、条件判断和 Prompt 渲染不得直接持久化，预览工作状态最终丢弃。失败、取消不写部分结果。Global/Session 版本可用各行独立状态 revision 列或等价可靠的比较机制；不得依赖无条件整行覆盖。Message 的工作状态由正确父链最近有效 state 解码后的完整对象复制而来，模型变更应用于 Prompt 脚本更新之后；按已声明字段路径依序应用 `set/adjust/append`，对象其他字段保留，`json/array` 的 `set` 整值替换，数组 `append` 追加；不使用不加区分的深合并。所有操作与最终状态校验成功后编码为一个完整数组，随最终 Assistant 在同一事务提交；失败或中断不写已结算状态，不修改父 Entry，重生成重新读取原父链。状态不可跨分支查询，且与模型上下文裁剪无关。

`ext_data` 为应用自有 JSON 对象，默认 `{}`，保存可选 `stateChanges`、`stateReset`、`origin` 及摘要覆盖边界和生成记录；禁止覆盖 Pi payload 或作为状态本体。应用 Summary 使用 `type=compaction` 和 Fanto 格式的 compaction payload，`ext_data.summary = {kind: "sillyrealms.summary", coveredThroughEntryId, generation}` 标识应用摘要；它由应用生成，不声称 Pi 原生 compaction 流程已运行。SDK 是否能正确恢复这种生成记录须 PoC；无法满足时不得伪装兼容。

正常 Pi 主轮完成的每条 user/assistant/toolResult 消息分别写 Entry；消息、ToolCall 和 ToolResult 原样保留。SSE 增量不单独写 Entry。SDK 若产生 custom，适配层明确报不支持，不丢弃、不改成其他类型；需在集成 PoC 验证不会产生影响主流程的 custom。

`role` 是 `payload.message.role` 的索引冗余列；仅 message 有值，写入和恢复时校验一致。叙事查询先限制当前父链，再按 role 过滤并做 NarrativeProjection。

## 4. Run 关系、游标查询和分叉

- 每次玩家发送生成新的 `run_id`；同轮 Summary compaction Entry、User、Assistant/ToolResult/后续 Assistant 共用这个 ID。创建 Session 时 Opening 也有一个独立初始化 run_id。
- Assistant 重新生成属于原 User 的**同一逻辑 Run**，分叉数据通过 parent_id 辨别；编辑 User 生成新的兄弟 User，属于**新 Run**。
- `getRunPage` 先沿 `sessions.tip_entry_id` 的 parent_id 得到**当前分支祖先链**，再按 run_id 分组，按每个 Run 在当前分支最早 `MIN(seq)` 倒序选 `limit` 个 Run；再读取这些 Run 的**全部祖先 Entry**（`seq ASC`）。
- 游标 `nextCursor` 是该页最老 Run 的 `run_start_seq`；下一页只选 `run_start_seq < cursor`。limit 计 **Run 而非消息/Entry**，例如一次用户交互输出了 1 条 User、3 条 Assistant、2 条 ToolResult，也是一页额度中的**一个 Run**。
- **不能先按 run_id 全 Session 查再筛世界线**。相同逻辑 Run 可能有多个 Assistant 备选分支；必须先筛父链，只读取当前选择的那一条路径。切换 tip 后客户端清空旧游标。
- `getChatPage` 使用同一批 Run 结果再做 NarrativeProjection，仅展示 user/assistant 叙事。Raw Run 页面则可返回 ToolCall/ToolResult/技术 Entry 供内部调试。
- 最近有效 State 和摘要覆盖边界都沿真实祖先读取，与按 Run 分页及按 Token 缩短 Prompt 无关。

### 世界卡的级联删除与资产边界

- `deleteWorld(worldId)` 是**彻底删除**：前端明确二次确认；服务端先阻止该世界新增 Session/Run、停止并等待在途运行退出，收集世界与各 Session 的本地独占资源目录。
- 在一个 SQLite 事务中 `DELETE FROM worlds WHERE id=?`，由 `sessions.world_id ON DELETE CASCADE` 和 `entries.session_id ON DELETE CASCADE` 删除**全部会话、全部分支、全部 Run/消息/技术 Entry**；摘要、状态随所在 Entry 一起删除。也可显式按依赖顺序删除，但不可留孤儿记录。
- 资产资源采用可核验的**世界/Session 独占命名空间**：世界卡 `assets[]` 和会话附件属于其拥有者；引用同一文件的多个世界必须使用共享资源管理/引用计数或独立拷贝，**绝不删仍被其它 World 使用的文件**。外部 HTTP 链接只移除引用，不远端删除。无独立资源业务表时，磁盘资产路径/清单需有可恢复的清理规则。
- 为防止数据库已提交而文件删除失败，先把要删除的独占目录原子移到隔离待清理区（失败回滚），事务提交后清理隔离区；清理失败由下次启动的幂等回收重试并记录错误，不能宣称已完成物理文件清理。Session 单独删除采用同样机制。全局 Preset、Provider Key、Tag 不属于该世界，保持不变。

## 5. 世界状态、配置与运行次序

- Session 创建 = 短事务写 Session + 初始化 Run + 根 Assistant Opening Entry（带 S0），设置 tip。
- 普通运行 = 读取分支/状态 → [Context Strategy](../design/context-strategy.md) 预检查 Token（必要时先摘要）→ 短事务写同一 run_id 的 Summary（如果生成）和 User → Pi 产生的消息依序写 Entry → 最终成功 Assistant 附完整新 State。
- 当只收到 `submit_turn.narrative` 而没有最终叙事正文时，将其规范化为独立 Assistant Message Entry，`origin=derived_tool_narrative`；原始 ToolCall 与 ToolResult 保留。
- `presets.config_json.budget` **仅**保存 `max_context_tokens?` 与 `max_output_tokens`；内部固定 Token 估算余量不向前端或持久化配置开放。实际输入上限 `min(预设上限, 模型 contextWindow) - 输出预留 - 内部估算余量`。WorldCard `data.context.strategy` 只有 window/summary，默认 window；`max_messages` 是条数阈值，不是 Token 阈值。
- 旧状态 Schema 与当前 WorldCard 不兼容，允许重新初始化 State；以前的消息和状态不删除。Key 不进入 WorldCard/Session/Preset 导出。
- `tags` 的类型内稳定排序通过 `ORDER BY sort_order, name, id` 实现；WorldCard.data.tags 仅存 type=world 标签 ID 数组。

## 6. 验收

- DDL 在 SQLite 内存环境执行，只有六张业务表；Entry 三类 enum、role 条件以及 state/ext_data JSON 形状、run_id NOT NULL 与索引正确。
- run_id 成组分页不丢同轮 Entry，也不混入另一个分支同 run_id 的回复；Opening、摘要都有 run_id。
- 消息原样入库、UI/下轮 Prompt/关键字用统一叙事投影；Token 窗口和摘要不修改 Raw History。
- 状态不依赖上下文裁剪，所有合法变更含 reason 和有效完整状态；模型/世界卡/角色关联与更新规则一致。