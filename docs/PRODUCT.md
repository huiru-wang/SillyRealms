# SillyRealms · 产品总纲

> **职责与权威范围**：产品目标、用户可见行为与范围的权威来源；技术协议分别以各领域和存储规范为准。

> 2026-11-04 目标方案，尚未实现。以世界卡驱动多角色叙事、分叉故事、可选状态管理与可配置预设。产品定位为本地个人应用，兼容通用 Pi Agent 消息语义。

## 1. 产品和平台

首期 Monorepo 只开发 **H5 Web + Server**，未来支持 Android、PC/Mac 桌面客户端；Web/Server 共用 WorldCard、模板、状态等纯逻辑。技术设计见 [Monorepo 架构](technical/architecture.md)。

主路径：**世界卡库 → 世界详情（开局、角色）→ 选择 Preset → Session → 聊天/状态栏 → 分叉世界线**。首页可直接按最近 Session 继续；世界卡删除须前端二次确认，随后级联删除全部关联会话、消息、状态和独占资源。

## 2. 产品对象

| 对象 | 基本能力 |
| --- | --- |
| WorldCard | 唯一当前版本，世界、角色、Opening、lorebook、状态定义、window/summary 两种 Context 策略；Session 通过 world_id 每轮读取最新值 |
| Preset | 选择模型和参数，配置 `off/inline/tool` 状态模式、摘要 Prompt、七系统节点/自定义节点及顺序 |
| Provider | 查询 Pi 内置模型；用户配置、测试、删除 API Key，模型可用性校验 |
| Tags | `id/type/name/sort_order`，同一 type 内排序，世界卡引用标签 ID |
| Session | `world_id/preset_id/user_character_id/tip_entry_id`，不存 World 快照、Opening ID 或模型/Options 冗余；`sessions` 无 role 字段 |
| Entry | 一条 Pi Agent 消息或技术记录，`run_id` 分组按 Run 分页、`parent_id` 构成世界分叉；`role` 方便 user/assistant/toolResult SQL 查询，`type` 为 message/compaction/branch_summary，state 和 ext_data 独立存储 |
| Narrative Context | 将 Raw Entries 统一投影成仅 user/assistant **叙事文本**；供 UI、模型历史和关键词扫描 |
| State | Global 归属世界卡跨会话、Session 归属会话、Message 沿当前父链；状态持久化，脚本局部/Run 变量临时 |
| AgentContext | 单轮构建器：当前 WorldCard/Preset、叙事策略、全量 State、lorebook/状态筛选、NodeBuilder → ModelMessage[] |
| Shared TextRenderer | 变量、条件、状态引用、受限文本变换，供 Agent/摘要 Prompt/世界卡预览/未来状态栏复用 |

## 3. 世界卡和玩家身份

世界卡只保存一份最新数据，没有 draft/published 历史版本；编辑立即影响已关联的 Session 下一轮生成。若新的状态 Schema 与已保存状态不兼容，保留旧数据、提示冲突并暂停依赖该状态的执行；仅在用户明确选择且完成备份后进行迁移或重建。

Opening 不设置 `player_characters`。可选角色就是世界卡中 `player_selectable=true` 的角色；如果一个也没有，用户先创建角色并**直接保存到当前世界卡**，再创建会话。选定 Opening 之后，它的正文就是第一条 Assistant 消息，不在 Session 另存 Opening ID。

世界书/角色/状态加载只支持 `always` 和 `on_mention`。当关键词和 `when` 同时配置时，**关键词命中 AND when(fullState) 为 true** 才激活；排除词命中则不激活。角色支持 `order`，世界书按 `anchor/position/order` 排序。不存在 manual 激活模式。

## 4. 两种上下文策略与 Token 上限

WorldCard `data.context` 只支持 `window`（默认）和 `summary`，**不允许 none**。Preset 配置 Token 上限，Provider 提供模型最大 contextWindow：

| 策略 | 基本流程 |
| --- | --- |
| `window`（默认） | 先最多保留最近 N 条 user/assistant 叙事，构建一次 Prompt 并检查完整 Context Token；超预算只裁剪旧 messages，不重新匹配 lorebook，直到满足预算或明确报错 |
| `summary` | 未覆盖消息达到 N 条**或**完整 Prompt 提前超预算时先摘要旧内容，优先保留最近 K 条原文；生成后重新校验 Token，不允许丢弃未摘要的消息 |

有效输入预算 = `min(预设 max_context_tokens（若有）, Provider.contextWindow) - max_output_tokens - 内部固定 Token 估算余量`；**用户只配置 max_context_tokens / max_output_tokens**。系统 Prompt、角色、世界书、状态、当前 User 和工具定义都要计入，当前 User 不能裁掉。摘要 Prompt 可读取**完整状态**；摘要作为 `compaction` 技术 Entry（通过 `ext_data.summary` 标记） 保存覆盖边界与完整摘要请求/回复，原始消息不删除。

**三个概念不能混淆**：Raw History 是全部消息和分支；Narrative Context 是叙事消息候选及其压缩结果；State 是独立的 Global、Session 和当前分支 Message 状态。**关键词扫描压缩前的候选叙事 + 当前 User，Prompt 只构建一次；压缩导致关键词消失也不重匹配。**所有 when 在 Prompt 脚本前读取初始完整 State；worldState 本体在全部 Prompt 脚本完成后读取工作状态并填回原位置。

## 5. 工具消息与显示

每次 Pi Agent 产生的 **user、assistant（含 toolCall 内容块）、toolResult** 消息都正常持久化到 Entries；不能把 ToolCall/ToolResult 仅当调试日志或丢弃。

但用户聊天页面、下一轮模型真实聊天历史、世界书和状态根关键词扫描都使用同一个 NarrativeProjection：**只包含 user 和 assistant 的叙事文本**，从 Assistant 中移除 ToolCall、思维和状态更新内联块，ToolResult 整条不入投影。

本次模型执行过程中仍可使用真实工具交换；只是下一次模型调用不把上一轮状态工具消息重放。StateEngine 在最终有效 Assistant 上保存全量状态和每项带 reason 的变更，状态栏可展示原因。

## 6. 最小可行技术范围

SQLite 只保留六张业务表：`worlds/presets/provider_credentials/tags/sessions/entries`。Entry 每条消息一行，但必须有 `run_id` 以便按 Run 分页；无需独立 Run、Message、ToolCall、WorldTag 或 AppSettings 表。

Monorepo 首期完成 H5、Server、六表数据库、Provider API Key、世界卡、预设、状态、两策略 Context、消息级分叉、Root/Fork 世界线与状态栏。暂不做 Android、Desktop、云端同步、多用户协作、无隔离直接执行来源 JS/EJS和复杂分布式并发。

详见 [WorldCard](design/world-card.md)、[Preset](design/preset.md)、[Session](design/session.md)、[Context Strategy](design/context-strategy.md)、[AgentContext](design/agent-context.md)、[State](design/state.md)、[Storage](technical/storage.md)、[架构](technical/architecture.md)、[实施计划](technical/implementation-plan.md)。
