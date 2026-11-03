# Storage：六张业务表与 Entry 分叉树

> 2026-11-03 第二版精简方案，**尚未实现**。目标是本地单人 SQLite，不为未来多端、分布式并发或复杂审计提前建表。完整业务协议见 [Session/Entry](../design/session.md)、[AgentContext](../design/agent-context.md)、[Provider](../design/provider.md)、[文本渲染](../design/text-rendering.md) 和 [State](../design/state.md)。

## 1. 唯一六张业务表

| 表 | 核心字段 | 作用 |
| --- | --- | --- |
| `worlds` | `id, name, data_json, status, created_at, updated_at` | 世界卡当前数据，包含角色、Opening、WorldBook、状态 Schema、资源；`status=draft/published` |
| `presets` | `id, name, config_json, is_builtin, created_at, updated_at` | 预设节点数组、role/启停/顺序、预算、触发扫描深度 |
| `provider_credentials` | `provider_id, credential_ref, updated_at` | ProviderService 管理用户 API Key 的安全存储引用；Pi 模型目录不入库 |
| `tags` | `id, type, target_id, name, created_at` | **唯一通用标签关联表**：`type=world/preset/session` 等明确对象类型，替代 `world_tags` |
| `sessions` | `id, world_id, world_snapshot_json, opening_id, user_character_id, preset_id, model_selection_json, options_json, active_entry_id, title, created_at, updated_at` | 一局世界快照、身份、选项、当前世界线叶子 |
| `entries` | `id, session_id, parent_entry_id, kind, text, runs_json, selected_run_id, created_at, updated_at` | 一次可分叉回合；`runs_json` 内保存生成/重试、内部工具消息、全量状态 |

`worlds.data_json` 只保存世界卡完整当前内容；不再额外保存 `published_json`/`draft_json` 两套。编辑发布是世界卡当前的状态标志；Session 创建时复制当时内容作为世界快照，后续改卡不影响旧 Session。`sessions.world_snapshot_json` 已含角色信息和 State Schema，因此不建角色/状态 Schema 的重复字段。

**不创建** `runs`、`messages`、`run_tool_calls`、`app_settings`、`world_tags`、`context_checkpoints` 或 `schema_migrations` 表。SQLite 的迁移版本可使用 `PRAGMA user_version`，由代码中的 migration 文件升级。世界卡资源引用保留在 JSON/本地文件路径中，MVP 不新建资源表。

### 1.1 六表最简 SQLite DDL（示意）

以下是可直接作为第一版迁移基础的字段设计。`JSON` 在 SQLite 使用 `TEXT` 存储，由领域服务验证结构；不额外建子表或复杂约束。`created_at/updated_at` 使用 Unix 毫秒。

~~~sql
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
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
  target_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (type, target_id, name)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  world_snapshot_json TEXT NOT NULL,
  opening_id TEXT NOT NULL,
  user_character_id TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  model_selection_json TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  active_entry_id TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_entry_id TEXT REFERENCES entries(id),
  kind TEXT NOT NULL DEFAULT 'turn',
  text TEXT NOT NULL,
  runs_json TEXT NOT NULL DEFAULT '[]',
  selected_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_entries_session_parent
  ON entries(session_id, parent_entry_id);
CREATE INDEX idx_entries_session_time
  ON entries(session_id, created_at);
CREATE INDEX idx_tags_target ON tags(type, target_id);
CREATE INDEX idx_tags_name ON tags(type, name);
~~~

`sessions.active_entry_id` 指向同 Session 的 Entry，`selected_run_id` 指向本 Entry 的 `runs_json[]` 中一个成功 Run，这两项用简单服务校验，不强行做跨 JSON 的 SQLite 外键。`tags.target_id` 是多类型目标，同样由 TagService 验证。初始化应启用 `PRAGMA foreign_keys=ON`；不额外创建迁移历史表，使用 `PRAGMA user_version`。`provider_credentials.credential_ref` 是密钥位置/别名而非明文 API Key。

## 2. Entries 保存 Run 列表

~~~ts
type Entry = {
  id: string;
  sessionId: string;
  parentEntryId: string | null;
  kind: "opening" | "turn" | "summary";
  text: string;
  runs: Array<{
    id: string;
    status: "running" | "completed" | "failed" | "stopped";
    assistantText?: string;
    rawText?: string;
    stateSnapshot?: Record<string, unknown>; // 每次完成生成的全量状态
    stateChanges?: StateChange[];             // 可选增量，不是权威快照
    piEntries?: unknown[];                    // 可选内部模型/工具往返
    usage?: unknown;
    error?: string;
    createdAt: string;
    finishedAt?: string;
  }>;
  selectedRunId: string | null;
};
~~~

每个 Entry 一行，`parent_entry_id` 构成分叉树；`runs_json` 是上述 `runs[]` 的 JSON 数组，不需要单独的消息/运行表。

- `opening`：一条根 Entry，`text` 为开局文本，`runs` 有已完成初始状态 S0。
- `turn`：`text` 是玩家本轮输入；一次或多次 `runs` 表示生成、失败、取消、重试或将来的重新生成。`selected_run_id` 指向本分支真正采用的**completed** Run。
- `summary`：`text` 是压缩摘要；`runs` 有一条已完成、携带压缩锚点完整状态的记录。摘要只用于上下文裁剪，不算玩家新行为。
- 成功 Run 的 `stateSnapshot` 是该分支截至此 Entry 的**完整权威状态**；失败或未选中的 Run 不覆盖它。没有状态定义时使用空对象。
- `piEntries` 仅用于需要的调试/重试信息，允许保存 toolCall 与 toolResult，建议脱敏、体积限制；不为每个流式 token 落库。回灌模型历史时只取选中 Run 的可见 `assistantText`，不回灌工具调试消息。

普通消息展示可由 `Entry.text` 和所选 Run 的 `assistantText` 生成，不必冗余保存 `messages`。如用户重试同一个 Entry，只追加 Run，不产生新的树节点。

## 3. Session 选项与模型默认值

`sessions.options_json` 可以容纳以下轻量配置：

~~~json
{
  "history": { "max_messages": 40 },
  "state_update_mode": "inline",
  "manual_lore_ids": [],
  "manual_state_ids": []
}
~~~

`history.max_messages` 应只计最近 Summary 之后的 User/Assistant 可见消息，摘要作为前缀总是保留；缺省表示不设条数上限（仅受模型实际上下文和必要裁剪约束）；它与 Preset 的触发扫描深度不同。若没有用户选项也可以保存 `{}`，不要为每个选项建列、修订、版本链。

模型选择保存在 `sessions.model_selection_json = { "provider": "...", "modelId": "..." }`。**不设 `app_settings` 表**：MVP 创建 Session 时明确选择模型；如前端希望记住上次选择，可以存在本地前端偏好或本地应用配置文件，绝不需要为此单建一个任意键值表。Preset 不保存模型 ID。

`provider_credentials` 仅保存 Provider ID 到安全凭据的引用；密钥实体由与 Pi `CredentialStore` 兼容的本地安全存储持有。项目需设计数据目录与备份策略，不能把明文 Key 写进导出世界卡或 Session。

## 4. 标签使用一张表

~~~text
tags
  id         TEXT PRIMARY KEY
  type       TEXT NOT NULL     -- world / preset / session（可扩展枚举）
  target_id  TEXT NOT NULL     -- 被打标签对象的 ID
  name       TEXT NOT NULL
  created_at INTEGER NOT NULL
~~~

标签列表：`WHERE type='world' AND target_id=?`；按标签筛世界：`WHERE type='world' AND name=?`。建议 `UNIQUE(type,target_id,name)`；不用 `world_tags` 关系表，也不创建复杂的标签字典 ID + 多对多映射。标签更名首期按 `type/name` 更新对应行即可。

## 5. 最小索引

索引已直接定义在 §1.1 的 DDL 中：Entry 父链、Entry 会话时间、标签按对象及名称筛选。没有世界线物化索引、状态快照索引和单独的 Run/Message 索引。§entries.id§ 及其它实体 id 由主键覆盖。

## 6. 最简写入过程

1. **创建 Session**：校验世界卡/Opening/用户角色/Preset/模型与本地凭据，读取世界 JSON 一次；写 Session、Opening Entry、active_entry_id。用一个小型 SQLite 事务避免半初始化。
2. **提交用户输入**：在活动叶子下写一个 `turn Entry`，`text` 为玩家原文、`runs[]` 首条 running；更新 `sessions.active_entry_id`。可用一个小事务。
3. **生成成功**：将完成的 Run 正文/必要工具轨迹/状态变化/完整快照写入该 Entry 的 `runs_json`，`selected_run_id` 选择它。**若状态必须更新而更新格式无效，则此 Run 标为失败/需修复，不把非法状态结算成成功。**
4. **取消/失败**：将当次 Run 标 failed/stopped，保留玩家 Entry.text；重试直接向这条 Entry 的 `runs[]` 追加新 Run。没有额外的 Run 行、Message 行、Tool 行要同步。
5. **世界线切换**：只改 Session.active_entry_id；历史从新叶子沿 `parent_entry_id` 读取，选定 Run 的全状态从对应分支查找。
6. **历史压缩**：创建一个 `summary Entry` 作为当前分支的后继，其 `text` 是摘要，`runs[]` 携带锚点完整状态；之后从它继续。历史保留以便分叉，但 AgentContext 从最近摘要起构建历史。

本地单人应用只对同一 Session 的**一条正在生成请求**做内存互斥；保留关键多行写入的小事务，不设计 request_id、generation_id、乐观 revision、分布式锁、版本失效矩阵、状态过期图。编辑已有有子节点的 Entry 时提示从该位置分叉，不自动传播修改到后代。

## 7. 查询与验收

- 获取历史：沿 `active_entry_id` 的真实父链查询，按 Entry 分页，例如最近 30 个互动 Entry，显示选中 Run 的 User/Assistant；Summary 可渲染为历史压缩标识。
- 获取全量状态：沿当前目标父 Entry 向上找最近一个有成功选中 Run 的 `stateSnapshot`，不依赖上下文近期 N 条或最近 summary 之前的模型历史。
- 世界线：从同 Session 的 `entries.id/parent_entry_id/kind` 派生 Root/Fork-only 压缩图，非交互 summary 不计入分叉/隐藏回合。
- 工具执行：只可嵌入 `runs_json.piEntries`，不另建 `run_tool_calls`。
- 最终校验数据库只含上述 **6 张业务表**（SQLite 系统表不算业务表）、每条世界线能恢复正确叙事和状态、应用重启后可恢复未完成 Entry。

如已存在旧实验 SQLite，迁移前备份并明确映射老 Run/Message 为 Entry + 内嵌 Runs；当前仍为设计阶段，不自动迁移真实用户数据。
