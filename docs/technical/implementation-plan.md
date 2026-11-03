# SillyRealms 实施计划：Monorepo / 消息级 Entry / 三种上下文策略

> 2026-11-04 更新，仍为设计阶段；本次只修改文档和示例。遵循 [产品总纲](../PRODUCT.md)、[Session](../design/session.md)、[Context Strategy](../design/context-strategy.md)、[AgentContext](../design/agent-context.md)、[Storage](storage.md)。

## 0. 冻结的 MVP 决策

| 领域 | 最小方案 |
| --- | --- |
| 项目结构 | pnpm Monorepo：当前 apps/web、apps/server、packages/core/shared（按需）；Android/Desktop 延后 |
| WorldCard | worlds.data_json 一份当前世界卡，Session 只存 world_id；无 draft/世界快照/Opening ID |
| Session | world_id、preset_id、user_character_id、tip_entry_id；角色当前读取最新世界卡，若无 player_selectable 先创建并保存 |
| Preset | 关联 Provider/Model/模型参数、状态模式、summary_prompt、有序七系统 NodeBuilder/自定义节点；无独立 scan_depth |
| Entry | 一条 Pi Agent Message：id/session_id/parent_id/seq/type/timestamp/payload，原始 User/Assistant（含 ToolCall）/ToolResult **全部持久化** |
| 三份数据 | Raw History（完整）/Narrative Context（只含 user/assistant 叙事）/Current State（独立完整快照），不同读取用途不可混淆 |
| Context | WorldCard none=全部叙事；window=最近 N；summary=超阈值摘要+保留最近 K；Prompt 在 Preset 支持状态模板 |
| 条件触发 | only always/on_mention；关键词与 when(fullState) 是 AND；角色支持 order，世界书 anchor/position/order |
| State | 每条变更必须非空 reason；最终 Assistant 记录全量状态；最新世界卡 Schema 不兼容时可舍弃旧快照重置 |
| SQLite | 仅 worlds、presets、provider_credentials、tags（type 内 sort_order）、sessions、entries 六表 |

## 1. 阶段 A：仓库与 SDK PoC

- [ ] A1. 采用 pnpm-workspace，构建 apps/web（React/Vite）和 apps/server（Hono），仅抽出实际需要复用的 packages/core/text、packages/shared 类型；Android/Desktop 先不创建平台工程。
- [ ] A2. 锁定 Pi Agent/Pi AI 版本，查明真实 Message 类型：Assistant 内 toolCall 内容、独立 ToolResult、User/Assistant 文本；保证原始消息按顺序可完整持久化和恢复。
- [ ] A3. 验证新的模型历史**只投影叙事文本**，Pi SDK 真实 HTTP 请求不附加旧 ToolCall/ToolResult，当前 User 恰好一次；真实 Provider 的 SSE/后置 system 顺序/Tool Calling 必须实测。
- [ ] A4. ProviderService 使用 Pi 内置模型目录与安全 CredentialStore；Preset 中选择模型/参数，连接测试显式发起，不存密钥到预设或世界卡。

## 2. 阶段 B：六表领域和 Session

- [ ] B1. 实现 [Storage](storage.md) 六表 DDL、`PRAGMA foreign_keys`、`PRAGMA user_version` 迁移和最小索引；不建 runs/messages/run_tool_calls/app_settings/world_tags/context_checkpoints 等表。
- [ ] B2. `worlds` 保存一份当前卡，不建 draft/发布版本；`sessions` 只关联 World/Preset/角色/Tip。创建时选 Opening 直接变成根 Assistant Entry + S0。
- [ ] B3. 若 WorldCard 缺少可扮演角色，Web 提示用户创建角色并直接写入 worlds.data_json；已开局 Session 的 user_character_id 在新卡中失效时也要求重新选或创建角色，不注入不存在的身份。
- [ ] B4. `tags(id,type,name,sort_order)` 同类型内稳定排序；WorldCard.data.tags 为标签 ID 数组，不建 world_tags。
- [ ] B5. `entries` 按消息级 payload 持久化所有 Pi User/Assistant/ToolResult 和 Summary，Assistant ToolCall 不能漏；parent_id/seq 分叉、User 重选与 Assistant 重生成、Root/Fork-only 压缩视图。
- [ ] B6. 提供唯一 `narrativeProjection`：UI/模型历史/关键词扫描只保留 user/assistant 叙事，工具消息留库但不回灌。

## 3. 阶段 C：Context 三种策略与 Agent

- [ ] C1. WorldCard context.strategy 支持 none/window/summary，参数 max_messages 与 keep_recent_messages 只针对策略生效：none 无压缩，window 最近 N，summary 阈值 N 时摘要较老消息并保留最近 K。
- [ ] C2. Summary Entry 物理追加在原 tip 之后并记录 coveredThroughEntryId；逻辑模型 Context 为「最新摘要前缀 + 覆盖边界后的原始可见消息」，**不能误丢保留的最近 K 条**；分支专用，旧记录不删除。
- [ ] C3. Preset.summary_prompt 支持完整 State 只读变量；摘要输入只含叙事，不含工具。**摘要在当前 User Entry 入库前完成，新 User 接新 Summary 后面**，保证自身输入不被摘要或重复发送。
- [ ] C4. AgentContext 独立读取全量 Raw Entry 父链、同分支最近有效 State、当前 Narrative Context；世界卡 Schema 不兼容时允许重置旧状态，不做复杂版本迁移。
- [ ] C5. 世界书/角色/状态根激活规则只支持 always/on_mention + 可选 when（AND），统一在**当前最终 Narrative Context + 当前 User** 上关键词匹配；角色 order、世界书 anchor/position/order。
- [ ] C6. 七个系统 NodeBuilder + CustomTextNodeBuilder 有序执行，统一使用 packages/core/text 的 TextRenderer 渲染模板，历史/用户原话只做 literal；最终只返回 ModelMessage[]。
- [ ] C7. AgentRuntime 在主轮 Pi 期间正常保存所有完成的 Assistant ToolCall Message / ToolResult Message / User/Assistant；下一轮不恢复旧工具消息到模型聊天历史。
- [ ] C8. StateEngine 的所有 StateChange 必须有 reason，生成结束校验并在已完成 Assistant Entry 存全量 State；off 模式继承、invalid 不能假装成功。终止 submit_turn 只有 narrative 时须规范化追加可见 Assistant Entry（标记来源），原始 ToolCall/ToolResult 不动、不得重复正文。

## 4. 阶段 D：Web/Server API 与 UI

- [ ] D1. WorldCard 编辑、Opening 选择、玩家角色创建、世界书/角色排序/when；Context 策略配置在 WorldCard。
- [ ] D2. Preset 编辑：模型选择/参数、summary_prompt、状态更新模式、系统 NodeBuilder 排序、文本节点、导入导出；Provider API Key 与能力展示单独设置。
- [ ] D3. Chat UI 只显示 user/assistant 叙事，分页以可见消息为单位；开发诊断才能查看 Raw Entry 的 ToolCall/ToolResult。世界线 Root/Fork-only，内部工具节点不计回合数。
- [ ] D4. 状态栏复用 core TextRenderer 展示最新完整状态和每项变更 reason，状态失效重置应允许当前会话继续。
- [ ] D5. Context Preview 输出**实际模型历史叙事**、Summary/窗口边界、触发世界书/状态根、NodeBuilder 后的 ModelMessage[]；明确标注工具消息不再回灌。

## 5. 验收

- [ ] E1. Raw Agent Entries：user、assistant toolCall、toolResult、final assistant 的 payload 和 parent_id 顺序正确；生成失败后既有消息不丢。
- [ ] E2. 三种 Context 策略实际行为：Summary 在 User 前写入、coveredThroughEntryId 和保留 K 消息一致；关键词匹配与模型真实聊天历史一致，当前 User 仅一次。
- [ ] E3. State 不受 window/summary 影响；最新 WorldCard Schema 不兼容时允许重置；StateChange 缺 reason 被拒绝、合法更改写全状态。
- [ ] E4. WorldCard 无 draft/Opening 角色列表/Session 世界快照，Preset 存模型和摘要 Prompt，Tags type 内排序，角色 order 生效。
- [ ] E5. 数据库只有六张业务表；完整分叉可恢复，Pi SDK 实际请求严格不含旧 ToolCall/ToolResult，Web UI 只显示 user/assistant 叙事。
- [ ] E6. Monorepo Web/Server 构建测试通过，JSON 示例/Markdown 内部链接/SQLite DDL 验证通过。

**首期不做**：Android/Desktop、内容平台、多用户/分布式锁、通用 Agent 插件执行沙盒、任意 JS/EJS、世界卡历史版本、跨会话状态迁移、Run/ToolCall 独立业务表和复杂缓存。
