# Session / Entry：消息级历史、工具持久化与分叉

> 2026-11-04 设计稿。参考 Fanto 的 `sessions/entries` 字段命名，但不复制全部列：**Entry 是一条消息，不是一个 User+Assistant 回合**。存储的全量 Agent 历史、提供模型的叙事上下文、当前世界状态严格分离。见 [Context Strategy](context-strategy.md)。

## 1. 对象与字段

~~~ts
type Session = {
  id: string;
  worldId: string;
  presetId: string;
  userCharacterId: string;
  tipEntryId: string | null;
  title?: string;
  createdAt: number;
  updatedAt: number;
};

type Entry = {
  id: string;
  sessionId: string;
  parentId: string | null;
  seq: number;                // 只作 Session 内写入顺序，不推断祖先
  type: "message" | "summary";
  timestamp: number;
  payload: AgentEntryPayload | SummaryPayload;
};
type AgentEntryPayload = {
  message: PiMessage;         // 锁定 Pi SDK 版本的真实 Message
  stateSnapshot?: StateSnapshot; // 已完成 Assistant 可附全量状态
  stateChanges?: StateChange[];  // 每项变更含 reason
  stateReset?: boolean;          // 新世界卡 Schema 造成旧状态失效
  origin?: "pi" | "derived_tool_narrative"; // 标记规范化的工具叙事
};
type SummaryPayload = {
  text: string;
  coveredThroughEntryId: string; // 本分支已覆盖的真实叙事 Entry
  generation: {
    requestMessages: PiMessage[];
    responseMessages: PiMessage[];
  }; // LLM 摘要必须留存实际请求/返回
};
~~~

- Session **不含**世界快照、opening_id、model_selection_json、options_json。世界卡每轮由 world_id 读取最新数据，模型/参数/摘要 Prompt 从 Preset 取得。
- 一个 `Entry(type=message)` 对应一个实际 Pi Message：User、Assistant 或 ToolResult。Assistant 内的 toolCall 内容块、思维块和其它 SDK 数据留在完整 payload 中，不能抹掉。Summary 是专门的 Entry，仍包含摘要生成相关记录。
- 不建 Run/Message/ToolCall/State 的额外表；`entries.parent_id` 即完整世界线父指针。`sessions.tip_entry_id` 指向真实分支当前末尾（可能是 ToolResult、Assistant 或 Summary）。
- 最近有效全状态存在完成 Assistant 消息 Entry 的 `payload.stateSnapshot` 中。没有状态的世界使用空状态；不在 Session 复制状态或 Schema。

## 2. 创建世界实例

`createSession(worldId, openingId, userCharacterId, presetId)`：

1. 读取唯一当前世界卡，检查选择的 Opening 是否存在；角色只允许 `player_selectable=true`。如果没有可选角色，用户先新建一个并保存到当前世界卡，再选用。
2. 从 Preset 取得模型选择并由 ProviderService 验证，而不是让 Session 持久化模型。
3. 创建 Session 和一条根 Assistant Entry，内容就是用户选择的 Opening 正文；按世界卡初始 Schema+Opening 初始值生成完整 S0，并挂在根 Entry 的 payload 元数据。
4. `tip_entry_id` 指向根 Entry。根消息已经表达 Opening，不需要另外保存 opening_id。使用简单短 SQLite 事务防止初始化一半。

WorldCard 只有一份当前 data_json；编辑后所有旧 Session 下一轮读取新内容。如果当前 user_character_id 不再对应可扮演角色，则进入 Session 时先要求重新选择（或先创建并保存新角色），更新 user_character_id。若新状态 Schema 与历史快照不兼容，**允许旧状态失效并用新初始状态重新开始计算**，不要求复杂历史状态迁移，不阻止继续原故事。已保存的旧消息和旧快照仍在历史中，状态引擎不再使用旧 Schema 的值。

## 3. 每次运行：所有消息持久化

一个正常带状态 Tool 的运行可能写入：

~~~text
A0 (Opening; S0)
 └─ U1 (user 文本)
     └─ A1 (assistant 包含叙事 + toolCall 块)
         └─ T1 (toolResult, 包含状态工具结果)
             └─ A2 (assistant 最终叙事文本; S1)
                 └─ U2（下一次交互）
~~~

- 正常调用 Pi 时，将每条已形成的 **user/assistant/toolResult Message** 依次追加为 Entry；Agent 生成中的 ToolCall 属于 Assistant 消息内容的一部分，不能以所谓“内部调试”丢弃；ToolResult 作为单独 message Entry。实际 SDK 可能产生多个轮次，均需留存。
- SSE token delta 不是完整 Message，不要求逐 token 写 SQLite；模型流产出的完整 Message 按顺序落库。取消/错误前已形成的 Message 也保留，下一次生成明确选择合法的继续点或重新生成路径。
- 本轮状态工具提交只产生候选变更；在最终校验成功后，将**完整**的新状态和包含 reason 的变更记录附到完成的 Assistant Entry。失败不允许把非法快照标记为有效。`off` 继承旧状态。若终止型 `submit_turn` 只在工具参数中提供 `narrative`，未生成正常的 Assistant 叙事正文，则在**保留所有原始 ToolCall/ToolResult** 的前提下，再把经验证的 narrative **作为一条规范化 Assistant Entry 写入**，标记 `origin=derived_tool_narrative`；已有最终 Assistant 叙事时不能重复。
- 失败或重新生成 Assistant 时，不在 User 消息 JSON 中内嵌 runs[]；直接在指定 User 后新建另一条 Assistant 分支。新的工具消息自然挂在这条 Assistant 链下。
- 新轮运行**先**读取原 tip 的历史与 State；若摘要阈值已达，先写 Summary Entry，随后让本轮 User Entry 接在 Summary 后。不要先写 User 再摘要，也不要让当前 User 参加自己的历史压缩。
- 仅限制同一 Session 同时运行一次推理，保持最小 SQLite 事务；无需复杂 revision/generation_id 锁和第二套 Pi Session JSONL 权威存储。

## 4. 统一叙事过滤

~~~ts
function narrativeProjection(entry: Entry): { role: "user" | "assistant"; text: string } | null {
  if (entry.type !== "message") return null;
  const m = entry.payload.message;
  if (m.role !== "user" && m.role !== "assistant") return null;
  const text = extractNarrativeText(m); // 只取 text，去状态内联 XML、排除 thinking/toolCall
  return text.trim() ? { role: m.role, text } : null;
}
~~~

同一投影用于：
- **聊天 UI**：只展示 user/assistant 叙事，隐藏工具消息、工具内容块和 Summary（Summary 可做非聊天独立标记）。分页计数以可见消息为单位，不把工具 Entry 算作一页消息。
- **下一轮模型历史**：只用 user/assistant 叙事，加上世界卡上下文策略和当前 User。ToolCall/ToolResult 不进入新请求的历史；本轮**执行期间**依然按 Pi 协议传递工具调用。
- **世界书与状态关键词匹配**：扫描本轮经 Context Strategy 处理后的**同一组**叙事消息和当前 User 文本。没有额外的 scan_depth。

原始 Assistant 如果只有 toolCall 没有正文，它应正常存在数据库，但 NarrativeProjection 返回 null。绝不将 ToolResult 冒充 Assistant 文本插入 Prompt。

## 5. 世界线分叉

沿当前分支 `tip_entry_id` 逐个 `parent_id` 回溯，得到包含工具消息的完整原始链。用户看到的压缩世界线只计算可见故事节点：

- 正常继续：从当前实际 tip Entry 新建 User Entry。
- 历史 User 重新选择：新 User Entry 的 `parent_id` 等于原 User 的父 Entry ID（成为兄弟）。
- 重新生成某条 Assistant：从对应 User Entry 创建新的 Assistant 后继，保留原 Assistant/ToolResult 支链。
- 中途工具消息不构成用户决策，也不消耗产品上的「最多 3 条分叉」名额；按**可见故事分叉**检查上限，不能简单计算物理父节点的所有 child。
- Root/Fork-only 世界线图折叠普通消息和工具内部消息，线段隐藏回合数以**User 条数**统计，Summary/ToolResult 不计数。
- 切换分支只更新 `sessions.tip_entry_id`；原分支消息、摘要、状态不修改。

## 6. 摘要与窗口策略

`WorldCard.data.context.strategy` 是 `none / window / summary`，具体逻辑见 [Context Strategy](context-strategy.md)。

- none：从本分支全历史提取 user/assistant 叙事，绝不自动截断。
- window：只取本分支最近 N 条可见 user/assistant 文本，不生成摘要；旧消息仍在库中。
- summary：当最新 Summary 未覆盖的叙事条数达到阈值，调用 Preset 的可读取 State 的摘要 Prompt，将新 Summary 作为一条 Entry 追加到 tip 后，记录 coveredThroughEntryId；模型逻辑上下文为「最新 Summary + 被覆盖边界后的最近可见消息 + 当前 User」，不根据 Summary 的物理位置误删保留文本。

历史存储始终全量，世界线与状态读取始终沿实际父链，不因模型输入压缩而丢失分支。

## 7. 建议领域接口

~~~ts
createSession(worldId, openingId, userCharacterId, presetId)
getSession(sessionId)
getEntry(entryId)
getRawAncestorEntries(sessionId, tipEntryId)
appendMessage(sessionId, parentId, piMessage, metadata?)
appendSummary(sessionId, parentId, summaryPayload)
getNarrativeContext(sessionId, tipEntryId, strategy)
getCurrentState(sessionId, tipEntryId, currentWorld)
getChatPage(sessionId, tipEntryId, before?, limit?)
forkUserMessage(sessionId, historicalUserEntryId, newText)
regenerateAssistant(sessionId, userEntryId)
switchTipEntry(sessionId, targetTipEntryId)
getCompressedWorldlines(sessionId)
~~~

不需要 `appendEntryRun/completeEntryRun` 或单独 Run 表。路由首期围绕 `/sessions/:id/entries`、`/sessions/:id/chat`、`/sessions/:id/worldlines`、`/sessions/:id/forks`。

## 8. 验收

- ToolCall（Assistant 内容）和 ToolResult（独立 Entry）正常入库、可恢复执行链；UI/模型上下文/关键字扫描均不含它们。
- 三种策略下原始 Entry、旧分支和状态全量快照仍可回溯；世界卡变更可导致不兼容旧状态被重置。
- 角色身份只读最新世界卡，选开局即产生根 Assistant 消息，无 Session 副本。
- Assistant 重生成按 User 子分支，User 重选按原 User 的父 Entry 分叉，Root/Fork-only 仅统计可见互动。
