# Storage：六张业务表、消息级 Entries、全量 Agent 消息

> 2026-11-04 目标方案，尚未迁移生产数据库。个人本地应用：只保留 `worlds/presets/provider_credentials/tags/sessions/entries` 六张业务表。各模块分别见 [Session](../design/session.md)、[Context Strategy](../design/context-strategy.md)、[State](../design/state.md)、[Preset](../design/preset.md)。

## 1. 六表职责

| 表 | 核心字段 | 含义 |
| --- | --- | --- |
| worlds | id, name, data_json, created_at, updated_at | 单份当前 WorldCard；无 draft/status/版本链，含 Context 策略、Opening、角色、状态、世界书 |
| presets | id, name, config_json, is_builtin, created_at, updated_at | 模型 Provider/ID/参数、七系统节点/自定义节点、摘要 Prompt |
| provider_credentials | provider_id, credential_ref, updated_at | 用户 API Key 的安全引用，密钥本体存专用 CredentialStore |
| tags | id, type, name, sort_order, created_at | 同一 type 内可排序的标签字典；世界卡可在 data_json 引用 tag ID 数组 |
| sessions | id, world_id, preset_id, user_character_id, tip_entry_id, title, created_at, updated_at | 仅世界/预设/角色/当前 Entry 关联；世界卡和预设每轮读最新 |
| entries | id, session_id, parent_id, seq, type, timestamp, payload | 一条 Pi Agent Message 或 Summary；原始 ToolCall/ToolResult 正常留存；parent_id 构成分叉树 |

**明确删除** `world_snapshot_json、opening_id、model_selection_json、options_json、runs_json、selected_run_id、status(draft)` 及单独的 `runs/messages/tool_calls/world_tags/app_settings/context_checkpoints` 表。世界卡只有当前数据，旧状态 Schema 不兼容时允许重置旧状态。`tip_entry_id` 是分支真实末尾指针。

## 2. 最小 SQLite DDL（目标）

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
  UNIQUE (type, name)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  preset_id TEXT NOT NULL REFERENCES presets(id),
  user_character_id TEXT NOT NULL,
  tip_entry_id TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  parent_id TEXT REFERENCES entries(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('message','summary')),
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_entries_parent ON entries(session_id, parent_id);
CREATE INDEX idx_tags_type_sort ON tags(type, sort_order, name);
~~~

SQLite 中 JSON 存 TEXT，由应用层验证对应类型；用 `PRAGMA foreign_keys=ON` 维护基础引用，用 `PRAGMA user_version` 管理数据库迁移版本，无 `schema_migrations` 表。`sessions.tip_entry_id` 同 Session、`entries.parent_id` 不跨 Session、摘要锚点属于祖先链等用最简单的服务校验即可；不搞多用户并发锁矩阵。

## 3. Entry.payload 是原始 Agent 消息

~~~ts
type Entry = {
  id: string;
  sessionId: string;
  parentId: string | null;
  seq: number;
  type: "message" | "summary";
  timestamp: number;
  payload: {
    message: PiMessage;        // message 类型：真实 user/assistant/toolResult
    stateSnapshot?: StateSnapshot;
    stateChanges?: StateChange[];
    stateReset?: boolean;
    origin?: "pi" | "derived_tool_narrative";
  } | {
    text: string;              // summary 类型：摘要文本
    coveredThroughEntryId: string;
    generation: { requestMessages: PiMessage[]; responseMessages: PiMessage[] }; // 必存摘要调用
  };
};
~~~

所有主 Agent 运行产生的真实 Message 都存成独立 Entry：`user`、`assistant`（含其 content[].toolCall）、`toolResult`；不能只存用户可见的 Assistant 文本。Summary 是独立技术 Entry，摘要调用的真实请求和回复可放在其 generation 元数据中持久化；不为工具调用另建表。生成流的中间 token delta 可以不逐条存储，因为它不是 Pi 完成的 Message。

### NarrativeProjection

提供唯一读取视图，从 `message.role=user|assistant` 的内容**只提取叙事 text**（排除 ToolCall/思维/状态更新内联结构），空文本忽略；`toolResult` 和 Summary 不作为普通聊天消息。UI 和未来模型历史、关键词扫描都使用这个相同的投影函数；Summary 只按上下文策略转换为临时 assistant 前缀。

Raw Entries 必须保证工具调用与结果顺序、原始字段和 parent_id 结构不丢失。下一轮 Pi 真实历史**不回放**旧 toolCall/toolResult，但本轮执行内部仍可以使用工具协议。

## 4. 世界状态与世界卡更新

- Opening 选择后直接创建根 Assistant Entry，`payload.stateSnapshot=S0`；Session 不再保存 opening_id。
- 已完成的最终 Assistant Entry 存本轮完整 `stateSnapshot` 和每项带 `reason` 的 `stateChanges`。状态工具先候选计算、完成校验后再写有效结果；`toolResult` 本身不得被当作已结算状态。
- 下一轮状态读取沿当前分支完整原始父链，找最近有效的 Assistant 全量快照；**不因窗口/摘要而漏状态**。
- 世界卡 `worlds.data_json` 修改后直接影响已有 Session。若旧状态快照与当前 Schema 不兼容，**允许丢弃旧状态并按新 Schema + 初始值重新构建**；无需冻结 Session Schema 或做复杂兼容迁移。旧 Entry 自身仍保留历史 JSON，不保证新卡再能解释旧快照。

## 5. 标签和预设模型

`tags` 是多类型通用**标签字典**：`UNIQUE(type,name)`，`ORDER BY sort_order,name,id` 可保证 type 内稳定排序；世界卡 `data.tags` 存标签 ID 数组，保存世界卡时校验对应 ID 的 type=world。不建 `world_tags` 关联表、不通过标签行记录 target_id。以后扩展 Preset 标签也只需在其 config_json 存标签 ID 数组。

`presets.config_json` 中保存 `model: {provider,modelId,params}` 和 `summary_prompt`；`sessions.preset_id` 关联该预设。ProviderService 查询 Pi 的模型和凭据能力。没有 Session 模型 JSON，也没有 AppSettings 表。

## 6. 三种上下文策略落库

WorldCard `data.context` 保存 `strategy:none|window|summary`、`max_messages`、`keep_recent_messages`。Session 不再存 `options_json`。Summary Entry 的 payload 保存 `coveredThroughEntryId`，作为原始历史的压缩边界；用户可见历史仍能读取全部消息。

重点：**Summary 物理追加在 tip 后面，但逻辑历史按「Summary + coveredThroughEntryId 后的可见消息」重建**，不会在 Summary 处简单截断祖先。详见 [Context Strategy](../design/context-strategy.md)。

## 7. 最小写入/读取过程

1. 创建 Session + Opening Assistant 根 Entry + S0，用一个短 SQLite 事务写两行。
2. 首先从原 tip 读取真实历史和最新 State；若达到摘要阈值，**先追加 Summary Entry 到原 tip** 并更新 tip，再将玩家 User Entry 接在它后面（无摘要时直接接原 tip）。之后将模型输出的每一条 Assistant/ToolResult 继续按实际 Pi Message 顺序追加，更新 tip。取消失败时不删除已成型的工具消息。
3. 最终成功 Assistant Message 中保存原始 Pi 内容、有效状态快照、含 reason 的变更；若终止工具只有 `submit_turn.narrative` 而没有单独 Assistant 正文，则额外保存 `origin=derived_tool_narrative` 的规范化 Assistant Entry，保留原始 ToolCall/ToolResult。不重复已有的 Assistant 叙事；无有效状态结算时不能盖上成功快照。
4. 重生成 Assistant = 从历史 User 下创建新 Assistant 子分支；重选 User = 从旧 User 的父 Entry 下建新 User 兄弟分支。
5. 访问模型历史/关键词统一通过 NarrativeProjection 和 WorldCard Context Strategy；访问状态始终从原始父链独立读取有效全量快照。
6. 世界线 UI 压缩 Root/Fork，只计真正互动的 User 轮次，不把 ToolResult/Summary 当成分叉选择。

## 8. 数据验收

- 实际数据库只有六张业务表；DDL 可以在 SQLite 内存环境执行。
- Raw Entries 全量含 toolCall/toolResult、Message role/顺序；聊天与模型/关键词均只含 user/assistant 叙事。
- 三种 Context 策略和最新 Summary 锚点行为正确；切分支/重生成不丢历史。
- 世界/预设变更立即生效，旧不兼容状态可重置，旧消息保留；没有世界快照与冗余模型设置。
- Key 不回显、不落 WorldCard/Preset/Session 导出，关键多行初始化短事务通过。
