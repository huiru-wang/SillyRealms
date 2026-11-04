# Session / Entry：Run 分组分页、消息级持久化与分叉

> 2026-11-04 设计稿。**Session 是世界实例会话，Run 是一次玩家交互的逻辑分组，Entry 是一次实际消息或技术事件。** 不新增 runs 表；用 entries.run_id 完成按 Run 分页。参考 Fanto 的 run_id 分组机制，并扩展为**只查询当前世界线祖先链**。

## 1. 模型与归属

~~~ts
type Session = {
  id: string;
  worldId: string;
  presetId: string;
  userCharacterId: string;
  tipEntryId: string | null;          // 当前选中的真实分支末尾
  title?: string;
  createdAt: number;
  updatedAt: number;
};

type EntryType = "message" | "compaction" | "branch_summary" | "custom";

type Entry = {
  id: string;
  sessionId: string;
  parentId: string | null;
  runId: string;                       // 非空；同一次逻辑交互的所有 Entry 共用
  seq: number;                         // Session 内全局写入顺序，不代表祖先关系
  type: EntryType;
  role?: "user" | "assistant" | "toolResult"; // 仅 type=message；同步 payload.message.role
  subType?: string;                    // 仅 type=custom；映射 Pi CustomEntry.customType
  timestamp: number;
  payload: unknown;                    // 按 type 校验的 Pi Entry/本地扩展 payload
};

type AgentMessagePayload = {
  message: PiMessage;                  // role=user/assistant/toolResult，原样保存
  stateSnapshot?: StateSnapshot;       // 仅有效最终 Assistant
  stateChanges?: StateChange[];        // 每项必须有 reason
  stateReset?: boolean;
  origin?: "pi" | "derived_tool_narrative";
};

type SillyRealmsSummaryPayload = {
  summary: string;                     // 自定义 type=custom/subType=sillyrealms.summary
  coveredThroughEntryId: string;       // 最后被摘要覆盖的原始叙事 Entry
  generation: Array<{
    requestMessages: PiMessage[];
    responseMessages: PiMessage[];
  }>;                                  // 支持大文本分批滚动摘要
};
~~~

- **Entry.type 的合法值明确只有四种**：`message`、`compaction`、`branch_summary`、`custom`。这是对齐 Fanto 所用 Pi Session Entry 的四类，不把消息 role 误写成 Entry type。
- `message` 的 `role` 同步冗余 `payload.message.role`，合法值为 `user`、`assistant`、`toolResult`；非 message 必须为 NULL。如此 SQL 可按 `type=message AND role IN ('user','assistant')` 快速找到叙事候选。**必须先限制当前世界线的祖先链**，不能把其它分支的消息混进来。Assistant 的 ToolCall 是其 `content[]` 块，不是新的 Entry type，也不额外建 ToolCall 表。
- `compaction`：Pi 原生上下文压缩技术 Entry；`branch_summary`：Pi 原生分叉摘要技术 Entry；MVP 不主动调用 Pi 自带的压缩流程，但若 SDK 产生须完整保存，不作为聊天正文。
- `custom`：必须带 `sub_type`，用来保存本产品内部事件。该数据库字段在 Pi SDK 编解码边界映射为 SDK 的 `customType`，不能直接改动 SDK 的 Entry 结构。**WorldCard Summary 策略生成的摘要是 `type=custom, sub_type=sillyrealms.summary`**，payload 记录摘要、覆盖边界和全部摘要调用记录；不新增名为 summary 的 Entry type，也不冒充 Pi 原生 compaction。
- Session 不持久化世界卡快照、opening_id、模型配置、options 或 runs[]。模型和摘要 Prompt 每轮从 Preset 读取；角色/状态定义读取当前 WorldCard。所有 Raw Entry 与模型叙事历史、完整 State 分离。

## 2. Run 是逻辑互动单元，不是另一张表

- **普通发送**：生成新 `run_id`，当前 User、所有 Assistant（含 ToolCall）、所有 ToolResult、必要的摘要技术 Entry 都使用这个 ID。一次推理无论产生几条 Message，都属于**一个 Run**。
- **Opening**：创建 Session 时生成一个独立的初始化 `run_id`，根 Assistant Opening Entry 使用它。这样最早一页也有合法 Run，不需要让它成为孤立的 `run_id=NULL`。
- **Assistant 重新生成**：沿同一个历史 User 建另一条 Assistant 子分支，**沿用该 User 的逻辑 run_id**，而不是把原 User 和新 Assistant 拆成不同分页单位。可在 Runtime 内另建不落库的执行 attempt ID；不会把同一 Run 的不同分支混在一起，因为查询始终先按祖先链过滤。
- **重新编辑/重选历史 User**：从原 User 的父 Entry 创建新的 User 兄弟 Entry，分配**新的 run_id**，后续回复沿用新 ID。
- **分支切换**：只更改 `sessions.tip_entry_id`。旧 Run、旧分支全部保留。Run 不是物理消息数组容器，也不用于恢复分叉，`parent_id` 才是分叉关系权威来源。
- 失败/取消后的同轮恢复可以沿用原 `run_id`，但已成型的消息必须持久化，禁止用新 Run 覆盖旧消息。

~~~text
run_opening: A0（Opening，S0）
  └─ run_01: U1
       └─ A1（正文 + ToolCall）
            └─ T1（ToolResult）
                 └─ A2（最终正文，S1）
                      └─ run_02: [Summary?] → U2 → A3 ...

重生成 U1：
  U1（仍属 run_01）
   ├─ A1 → T1 → A2（旧分支）
   └─ A1' → T1' → A2'（新分支，仍属 run_01）
~~~

本轮 Pi 执行过程中保留真实 ToolCall/ToolResult 的结构、顺序与状态；下一轮构建模型历史只读取 user/assistant 的**叙事投影**，不重放旧工具交换。

## 3. 创建 Session 与本轮写入

`createSession(worldId, openingId, userCharacterId, presetId)`：

1. 读取最新 WorldCard，校验 Opening 和 `player_selectable=true` 的玩家角色。没有可选角色时先在当前世界卡中创建并保存角色。
2. 校验 Preset/Provider 模型，创建 Session 和初始化 Run 的一条根 Assistant Opening Entry，依据当前世界卡初始 State + Opening 覆盖得到 S0，附在根 Entry。
3. 一个短 SQLite 事务插入 Session、根 Entry 并设定 `tip_entry_id`；不重复保存 opening_id 或世界卡快照。

**普通发送**：从原 tip 读取 Raw 祖先、完整状态；运行 [Context Strategy](context-strategy.md) 并完成 Token 预检查；若须摘要，先在内存生成摘要并验证预算，然后在短事务中将 Summary（若有）与 User 以同一新 run_id 依次插入。Pi 形成的后续 Assistant/ToolResult Entry 按真实顺序落库，逐条更新 tip。

**状态结算**：状态工具的候选变更不等于已提交状态。最终成功后在完成的 Assistant Entry 存完整 S' 和带 reason 的变更。如果 `submit_turn` 仅提供工具参数 narrative，须保留原 ToolCall/ToolResult，再添加来源标识 `derived_tool_narrative` 的规范化 Assistant Entry，避免正文丢失或重复。未结算变更不得标为有效快照。

若世界卡更新导致历史快照不兼容，允许按当前 Schema 初值重置状态而不删除旧消息。若用户角色变成不可扮演，应先重新选择或在世界卡中新建角色。

## 4. 叙事投影和 UI

~~~ts
function narrativeProjection(entry: Entry):
  | { role: "user" | "assistant"; text: string }
  | null {
  if (entry.type !== "message") return null;
  if (entry.role !== "user" && entry.role !== "assistant") return null;
  const m = (entry.payload as AgentMessagePayload).message;
  if (entry.role !== m.role) throw new Error("ENTRY_ROLE_MISMATCH");
  const text = extractNarrativeText(m); // 只要 text，剔除 toolCall/thinking/状态指令
  return text.trim() ? { role: m.role, text } : null;
}
~~~

这里 `entry.role` 用来**数据库预筛选**，`narrativeProjection` 继续剔除思维、ToolCall、内联状态标签。这个**唯一投影**供聊天 UI、下轮模型历史和 lorebook/状态关键词匹配共享。UI 隐藏工具消息和技术 Entry，模型历史根据最终窗口/摘要再收缩；完整 Raw History 从未被压缩改写。纯 ToolCall Assistant 保留 Entry，但投影为空。

## 5. 按 Run 游标分页（核心语义）

`getRunPage(sessionId, tipEntryId, beforeRunCursor?, limit=10)` 的 `limit` **计 Run，不计 Entry，也不计可见消息**：

1. 从 `tipEntryId` 沿 `parent_id` 回溯得到**当前分支唯一祖先 Entry 集合**；不可直接扫描 Session 内所有相同 `run_id` 的行，否则会把其他世界线的回复混进来。
2. 在该分支内按 `run_id` 分组，取每组最早的 `seq` 作为 `run_start_seq`，按 `run_start_seq DESC` 倒序排列（新 Run 在前）。
3. `beforeRunCursor` 是上一页最后一个 Run 的 `run_start_seq`，下页只选 `run_start_seq < cursor` 的 Run。选择最多 `limit+1` 个 Run 判定 `hasMore`，实际返回最多 `limit` 个。
4. 返回**所选 Run 中当前祖先链的所有 Entry**，每个 Run 内按 `seq ASC`，而非仅取最后 limit 条消息；响应包括 `runs[]`、`hasMore`、`nextCursor`。若 UI 需要扁平数据，可额外同时返回 `entries[]`。
5. `getChatPage` 对同一批 Run 的 Entries 做叙事投影；单 Run 内可能包含 1 个 User、多个 Assistant/ToolResult、摘要等，不会因为一页的末尾恰好落在 ToolResult 中间而拆断一个 Run。
6. 切换 `tipEntryId` 时应**重置页面游标**；分页标识须绑定所选分支，防止跨分支复用旧 cursor。Opening 的初始化 Run 可以自然出现在最老一页。

~~~sql
-- 伪 SQL：先用递归祖先链限制当前世界线，再按 run_id 分组
WITH RECURSIVE ancestors AS (
  SELECT * FROM entries WHERE session_id = :sessionId AND id = :tipEntryId
  UNION ALL
  SELECT e.* FROM entries e JOIN ancestors a ON a.parent_id = e.id
  WHERE e.session_id = :sessionId
),
run_groups AS (
  SELECT run_id, MIN(seq) AS run_start_seq
  FROM ancestors GROUP BY run_id
)
SELECT * FROM run_groups
WHERE :before IS NULL OR run_start_seq < :before
ORDER BY run_start_seq DESC LIMIT :limitPlusOne;
-- 再只从 ancestors 取选中 run_id 的 Entry，按 run_start_seq、seq 组装
~~~

这沿用 Fanto **Run 游标 → Run 组 → 完整 Entries** 的思路，但对 SillyRealms 增加了**先按世界线过滤**。Run 是分页边界，Entry 是真实存储粒度，二者没有冲突。

## 6. 世界线分叉

- 普通继续：当前 tip 后新增下一个 Run 的 User；重新编辑历史 User：兄弟 User 新 Run；重新生成 Assistant：同 User 下新的 Assistant 子分支、共享逻辑 Run ID。
- ToolResult/Custom/Pi Compaction 不算玩家决策节点；Root/Fork-only 图只显示根与可见分叉，折叠中间消息。
- 世界线隐藏回合数量以**用户交互 Run** 计；Opening 可以作为根展示，但不算玩家回合。最多三条分叉等约束统计用户可见的决策分支，而不是物理 Entry 的子节点数。
- 真实父链、State Snapshot 和摘要边界都随分支切换，不复制整个世界状态或历史。

## 7. SessionService 只保留业务接口

下面是供首页、会话页面与用户动作调用的服务能力。**原始写入、父链读取、摘要技术 Entry、Run 原始查询都保留在内部 Repository/投影器中**，不是独立对外 Service；完整领域列表见 [领域 Service](domain-interfaces.md)。

| 接口 | 页面动作及业务含义 |
| --- | --- |
| `createSession(worldId, openingId, userCharacterId, presetId)` | 从当前 WorldCard + Preset 建会话，合法 Opening 根 Assistant Entry + 初始 S0 同事务写入 |
| `listSessions(cursor?, limit?)` | 首页最近会话列表，按最近活动游标分页 |
| `getSession(sessionId)` | 读取会话的世界卡/预设/角色 ID、title 和 tip |
| `updateSession(sessionId, patch)` | 改标题、有效玩家角色或 Preset 引用，旧 Entry 不变 |
| `deleteSession(sessionId)` | 删除这个 Session 的**所有**分支消息与独占会话资源，不删除世界卡 |
| `getChatPage(sessionId, cursor?, limit=10)` | 按当前 tip 选中的祖先链以 Run 为单位分页，返回叙事投影及游标 |
| `getWorldlines(sessionId)` | Root、分叉点、各分支首/末节点和折叠回合数 |
| `switchWorldline(sessionId, leafEntryId)` | 进入指定叶子节点代表的世界线，只更新 tip |
| `forkFromUserMessage(sessionId, historicalUserEntryId, newText)` | 在历史 User 的父节点下另写兄弟 User，生成新 run_id，并进入新分支 |
| `regenerateLastAssistant(sessionId)` | 仅最后一条 AI 回复可重生，当前 User 不复制；新 AI 分支沿用该 User 的 run_id |
| `continueLastAssistant(sessionId)` | 仅当前最后一条 AI 回复可续写，保留原 Entry，Runtime 追加后续内容 |

**内部依赖分工**：`EntryRepository` 负责 `findAncestors/findEntry/appendEntries`，写入时将 `role` 与 `payload.message.role` 校验同步；`RunProjector` 按当前父链执行 Run 分组与叙事投影；`AgentRuntime` 在运行中调用这些存储能力，把 Summary（若有）、User、Assistant、ToolResult 逐条写入同一逻辑 Run；`StateService` 读取完整状态。外部不允许通过“appendMessage”等方法伪造任意 Pi Entry。

**操作原子性**：分叉/重生成/续写这些用户动作只负责确定逻辑起点和父链，之后由 Runtime 使用对应的现有 User/Run 发起生成，**不得重复创建 User Entry**。停止或失败保留已经持久化的完整消息，不把正在生成的碎片当成新 Entry。世界卡删除时 Service 统一级联清理其全部 Session / Entry，含非当前世界线。

## 8. 验收

- Entry.type 四种合法值与 Pi 原生记录对应，Summary 用 sub_type 区分；message 的 role 与 payload 保持一致；所有 Pi 原始消息、ToolCall/ToolResult、技术 Entry 正常持久化。
- 同 Run 的多条 Entry 在一页内一次性返回；limit=10 表示最多 10 个 Run，而非 10 条消息；游标不拆 Run，分支互不串读。
- Summary 和当前 User 同 run_id；Opening 有自己的初始化 Run；Assistant 重生成保持同一逻辑 Run，历史 User 重选新开 Run。
- UI/下轮模型/关键词一致采用叙事投影，完整 State 与历史存储不受 Token 压缩影响；Window 默认、Summary 可选，细节见 [Context Strategy](context-strategy.md)。