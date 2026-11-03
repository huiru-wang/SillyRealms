# Session 与 Entry：单表回合、Run 列表及世界分叉

> 2026-11-03 第二版精简设计，尚未实现。参考 Fanto 的 `sessions + entries` 存储思想，但**SillyRealms 的 Entry 粒度刻意不同**：一个 Entry 是一个可分叉的完整互动回合，内嵌 `runs[]` 保存生成尝试和 Pi 过程；不另建 `runs/messages/run_tool_calls`。

## 1. 对象职责

- `Session`：一局世界实例。保存 world 快照、Opening、当前玩家角色 ID、Preset ID、ModelSelection、聊天窗口配置和 `active_entry_id`。
- `Entry`：一棵世界线上的一个节点。`parent_entry_id` 为唯一父指针。`kind=opening` 是根；`kind=turn` 是玩家输入回合；`kind=summary` 是可选历史压缩锚点。
- `Entry.runs[]`：该 Entry 的一次或多次生成尝试（初次、重试、重新生成）；每个 Run 可以保存最终叙事、内部 Pi messages/tool 过程、候选状态变化、**完整状态快照**、生成状态和错误。`selected_run_id` 指向这条世界线实际采用的成功 Run。
- **状态跟随选中 Run**：`runs[selected_run_id].state_snapshot` 即这个 Entry 的结算全量状态；其它 Run 可以保留以便用户查看重试记录，但不用于后续世界线历史或状态加载。

~~~text
Session (active_entry_id = E4)
└─ E0 opening [R0: 开场叙事, S0]
   └─ E1 turn: U1 [R1: A1, S1]
      ├─ E2 turn: U2 [R2: A2, S2]  路线 A
      │  └─ E4 turn: U4 [R4: A4, S4]  活动叶子
      └─ E3 turn: U3 [R3: A3, S3]  路线 B

Entry.parent_entry_id 构成分叉树；每个 Entry.runs[] 是该节点的生成尝试列表。
~~~

Fanto 的 entries 行是 Pi 的事件/消息 checkpoint，另带 run_id 归组；SillyRealms 不需要原样照搬其行粒度、usage_ledger 或运行缓存。这里只借鉴**Session + Entry 父指针 + JSON 载荷**的简洁性。

## 2. Entry / Run 推荐 TypeScript 结构

~~~ts
type EntryKind = "opening" | "turn" | "summary";
type EntryRun = {
  id: string;
  status: "running" | "completed" | "failed" | "stopped";
  assistantText?: string;        // 可见、已清洗的 AI 回复；开局为 Opening 内容
  rawText?: string;              // 可选原始响应，默认 UI 不展示
  stateSnapshot?: StateSnapshot; // 成功生成后完整状态，Opening 为 S0
  stateChanges?: StateChange[];  // 可选状态增量；不能替代全量快照
  piEntries?: PiEntry[];         // 可选内部工具/消息步骤（体积受限、可脱敏）
  usage?: Usage;
  error?: string;
  createdAt: string;
  finishedAt?: string;
};
type Entry = {
  id: string;
  sessionId: string;
  parentEntryId: string | null;
  kind: EntryKind;
  text: string;                  // turn=玩家输入；opening=开场文本；summary=摘要
  runs: EntryRun[];              // SQLite entries.runs_json
  selectedRunId: string | null;  // 只指向 completed 的 Run
  createdAt: string;
  updatedAt: string;
};
~~~

`runs[]` 是**Entry 内的生成记录**，并非数据库的 `runs` 表。通常只有一次生成；后续重试就在原 Entry 追加 Run。内部工具消息可记录在 `piEntries`，不需要独立工具表。不要把 `piEntries` 当作展示在聊天框的独立消息。

根 Entry `kind=opening` 在 Session 创建时写入 `text=opening`，`runs=[{status:completed,stateSnapshot:S0}]`；本局角色身份固定取世界快照中的选中角色。`summary` Entry 保存摘要文本并继承压缩锚点的完整状态（一次已选 Run），作为模型历史截断边界，不重复执行故事事件。

## 3. 创建 Session

`createSession(worldId, openingId, userCharacterId, presetId, modelSelection)`：

1. 校验世界卡、Opening、允许扮演的角色、Preset、Pi 支持模型及本地 API Key 配置。
2. 读取世界卡完整 `data_json` 并**复制**到 Session 的 `world_snapshot_json`；保存角色 ID、Opening ID、Preset ID、模型选择及基础历史参数。角色详情和状态 Schema 均从同一快照读取，避免多份冗余状态定义。
3. 创建 Opening 根 Entry，保存开场内容和初始完整状态 S0，`sessions.active_entry_id = opening.id`。
4. 本地 SQLite 使用最小事务避免「Session 有了但 Opening 没写」的半初始化；不引入乐观版本矩阵或分布式锁。

世界卡编辑不自动改变已有 Session 世界快照；如需要显式同步，按已保存状态 Schema 做必要兼容检查，不重演 Opening。

## 4. 消息发送、失败与重试

**新消息**：从活动叶子建立 `kind=turn` 的 child Entry，保存本轮玩家输入；追加一个 `status=running` 的 Run；Pi SSE 流式输出。成功后将经过状态校验的 Assistant、内部必要工具记录和完整状态写入此 Run，标记 completed 与 selectedRunId。失败/取消保留用户 Entry，Run 记录 failed/stopped，允许再次在该 Entry 中追加 Run 重试。

**模型 Context**：只使用祖先 Entry 的 `text` 和**选中 Run 的 assistantText**；工具回合和未选中的失败/重试 Run 不回灌模型历史。当前 User 即正在生成的 Entry.text，不能在历史重建后再重复追加。若当前 Entry 尚未成功，AgentContext 的 parentEntryId 指向其父 Entry，输入从自己 `text` 读取。

**状态**：每个成功选中 Run 写全量 `stateSnapshot`。失败 Entry 不提供新状态；最新状态从它的完成父链读取。没有 State Schema 的世界可使用空状态对象，不强行生成状态更新。

**局部一致性**：本地应用只允许每个 Session 同时进行一个生成（内存 in-flight 标志即可），SQLite 仅做短事务组合写入和单 Entry 更新，防止意外半写。无需 requestId 表、generationId 表、复杂锁/修订版本，也不用为单人应用设计跨进程并发体系。

## 5. 分叉与世界线

从历史 Entry E2 的玩家行动处“重选”时，新增一个 Entry，以 **`E2.parent_entry_id` 为 parent**，和 E2 构成兄弟；继承该父 Entry 的已选 Run 完整状态。正常继续则从活动叶子生成子 Entry。单个真实决策节点可维持**至多三个直接非 summary 子 Entry**，该规则由 SessionService 在创建时简单检查；超过则提示用户。

每个分支是一条从当前 Entry 沿 `parent_entry_id` 反向追溯的链。**不能靠创建时间或全局最大 ID 找历史、状态或世界书扫描文本**。

压缩世界线 UI 沿用原产品语义：只显示 Opening Root 和真正 Fork，普通节点和 Leaf 折叠进线段，边统计隐藏的**互动 Entry 数**，终止边可进入实际 `leaf_entry_id`。`summary` 是折叠用的技术节点，不算一轮玩家决策，也不凭空增加分叉数量。切换叶子只修改 `sessions.active_entry_id`，不复制整个 Session。

历史编辑/重生成已有分支内容时，不自动悄悄重算后代状态；若 Entry 已有后代，MVP 可限制只读/提示「从这里新建分叉」，避免完整 stale 修复体系。

## 6. 历史压缩与近 N 消息

`kind=summary` Entry 表示某条世界线完成一次历史摘要；它的 `parent_entry_id` 指向压缩时的真实锚点 Entry，后续生成接在 Summary 后。加载模型历史时从当前目标父节点沿本分支回溯，遇到**最近一次 summary** 即停止，保留摘要与后续文本。原历史仍保存在 SQLite 中供查看或从旧节点分叉。

`sessions.options_json.history.max_messages` 可限制进入模型的最近 N 条可见 User/Assistant 消息，按 Entry 完整回合边界向前截断；与 summary 共用时**始终保留最近 Summary 作为摘要前缀**，N 仅限制其后的可见消息，不读取更早祖先。`Preset.scan_depth_entries` 另行限制世界书/状态加载的关键字扫描范围，不能与历史窗口混淆。UI 分页默认 30 **互动 Entry**，不影响真实 Agent 历史加载。

## 7. SessionService 建议 API

~~~ts
createSession(input): Promise<Session>
getSession(sessionId): Promise<Session>
getEntry(sessionId, entryId): Promise<Entry>
getAncestorEntries(sessionId, parentEntryId): Promise<Entry[]>
getConversationHistory(sessionId, parentEntryId, options): Promise<EntryView[]>
getLatestState(sessionId, parentEntryId): Promise<StateSnapshot>
createTurnEntry(sessionId, parentEntryId, userText): Promise<Entry>
appendEntryRun(entryId, run): Promise<void>
completeEntryRun(entryId, runId, result): Promise<void>
failEntryRun(entryId, runId, error): Promise<void>
forkFromEntry(sessionId, historyEntryId, userText): Promise<Entry>
switchActiveEntry(sessionId, leafEntryId): Promise<void>
getEntryPage(sessionId, beforeEntryId?, limit?): Promise<EntryView[]>
getCompressedWorldlines(sessionId): Promise<WorldlineView>
createSummaryEntry(sessionId, anchorEntryId, summaryText): Promise<Entry>
~~~

接口只说明职责，不要求独立 `Repository` 接口、DTO 层或复杂编排器。建议路由 `/sessions/:id/entries`、`/sessions/:id/forks`、`/sessions/:id/worldlines`、`/sessions/:id/active-entry`、`/sessions/:id/entries/:entryId/retry`。

## 8. MVP 验收

- 六张业务表足够：`sessions + entries` 保存整个世界实例、聊天、工具尝试和状态；Pi Session JSONL 不是第二数据权威。
- Opening 唯一、成功 Entry 可按选中 Run 重建 User/Assistant，失败重试不产生新世界分叉。
- 分叉沿真实 parent_entry_id 读取历史与状态；不同分支上下文不串线。
- 压缩摘要与近 N 消息只影响模型历史窗口，不影响选择最新全量状态。
- UI 近 30 Entry 分页、Root/Fork-only 线图、隐藏数、真实叶子进入可用。
- 本地简单运行互斥足够，不需要 Run/Message/ToolCall/Checkpoint 独立表。
