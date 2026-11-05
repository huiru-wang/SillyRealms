# SillyRealms 实施计划：Run 分页 / 双策略 Token 预算

> **MVP 状态说明**：本文保留原有目标设计；若与本次 Server MVP 的已调整范围或实际行为冲突，以 [Server MVP 实施进度](../technical/server-mvp-progress.md)及其中链接的方案为准。文中的未来功能不代表已实现。

> **职责与权威范围**：实施任务和验收进度；目标协议以对应权威规范为准，任务勾选不代替验收证据。

> 2026-11-04 更新；仍为设计阶段，仅修改文档和示例。遵循 [产品总纲](../PRODUCT.md)、[Session](../design/session.md)、[Context Strategy](../design/context-strategy.md)、[AgentContext](../design/agent-context.md)、[Storage](storage.md)。

## 0. MVP 决策

| 领域 | 决策 |
| --- | --- |
| Monorepo | pnpm；首期 H5 Web + Server，core/shared 按需；Android/Desktop 延后 |
| WorldCard | worlds.data_json 一份当前卡；角色/Opening/lorebook/状态；Session 不存快照或 Opening ID |
| Session | world_id/preset_id/user_character_id/tip_entry_id；不加 role；按 parent_id 决定选中世界线 |
| Entry/Run | 每条消息/技术记录一行，`run_id NOT NULL`；按 **Run** 游标分页，limit 为 Run 数；不建 runs 表 |
| Entry.type | **message/compaction/branch_summary**；entries.role=user/assistant/toolResult（仅 message），摘要使用 compaction 与 ext_data.summary |
| Preset/Provider | 预设模型/参数、Token 预算、摘要模板和七系统 NodeBuilder；Provider 提供模型 contextWindow 与 API Key |
| Context | **window（默认）/summary；无 none**。window 先最近 N 条，超 Token 预算再删最老历史；summary 由 N 或超 Token 提前触发 |
| 三份视图 | Raw History 全量、Narrative Context 仅 user/assistant 叙事、Current State 独立完整状态 |
| lorebook/状态 | 仅 always/on_mention，可选 when(fullState)；关键词只匹配压缩前候选 Narrative Context + 当前 User，压缩后不重匹配 |
| State | 三作用域持久化、Run 临时变量；带 reason 的模型变更，最终 Assistant 附 Message 完整状态；最新世界卡 Schema 不兼容时保留状态，明确选择及备份后处理 |
| SQLite | 六表 worlds/presets/provider_credentials/tags/sessions/entries，无其它 Run/ToolCall 表 |

## 1. 阶段 A：基础与 SDK PoC

- [ ] A1. pnpm workspace、React/Vite H5、Hono Server、core/text 和 shared API。
- [ ] A2. 固定 Pi SDK 版本并核对 Entry 三类 type：message/compaction/branch_summary，并确认 SDK custom 的处理，原始 ToolCall/ToolResult 的完整序列化与恢复。
- [ ] A3. 真实 Provider 检查 role/order、SSE、取消、tool calling；下一次构建 Prompt 只回放 user/assistant 叙事，当前 User 不重复。
- [ ] A4. ProviderService 直接使用 Pi 内置模型目录，支持 API Key / CredentialStore；核对 contextWindow、maxTokens 和 Token 计数/估算可行性。

## 2. 阶段 B：六表和 Run/Session

- [ ] B1. 六表 SQLite DDL、`entries.run_id NOT NULL`、`role` 约束与索引、worlds/sessions 状态 JSON 对象、entries state JSON 数组、ext_data JSON 对象和非负 branch_count、world→sessions→entries 级联删除；不建 runs/messages/run_tool_calls 等表。
- [ ] B2. Session 通过当前 WorldCard + Opening 创建初始化 Run/根 Assistant/S0；可扮演角色不存在时必须先保存新角色。
- [ ] B3. Session 创建和模型/用户角色校验，`getWorld/getPreset` 单轮只读一次；世界卡/预设修改只影响之后的新 Run；不兼容状态须保留、提示，明确选择且备份后才可迁移或重建。
- [ ] B4. tags(id,type,name,sort_order) 同类型稳定排序；世界卡保存 tag ID。
- [ ] B5. **消息级持久化**所有 Pi User/Assistant/ToolResult、Assistant 内 ToolCall 和技术 Entry，归属逻辑 run_id；失败部分也保留。
- [ ] B6. **Run 级分页**：先按 tip.parent_id 收窄祖先链，后按 run_id 聚合，以当前链每组 MIN(seq) 为倒序游标，返回完整 Run；重生成 Assistant 与原 User 同 Run、不同 parent 分支；编辑 User 新 Run。
- [ ] B6a. 可见分支投影与 branch_count 同事务维护；历史分页批量返回，覆盖技术节点、分支删除及重建。
- [ ] B7. `entries.role` 支持按角色快速查询，`narrativeProjection` 为聊天/UI/模型历史/关键词扫描共用的唯一投影，不把 ToolResult 和 thinking 误显示。

## 3. 阶段 C：Token Context、摘要和 Agent

- [ ] C1. WorldCard 只有 window/summary，默认 window；max_messages=N，keep_recent_messages=K（summary 使用），禁止 none。
- [ ] C2. Preset budget 仅 max_context_tokens? / max_output_tokens。有效 B = min(预设最大值（可选）, Provider.contextWindow) - 输出 - 内部固定 Token 估算余量（首期 1024，不暴露用户）；计算包含整个 Prompt 与工具定义，预算非法/未知明确失败。
- [ ] C3. Window：先最近 N 条 user/assistant 叙事，若完整候选 Context 超 B，从最早消息逐条移除，**仅替换历史消息，不重匹配 lorebook/重建 Prompt**，直到能发送；固定 Prompt+User 仍超限则明确错误。
- [ ] C4. Summary：**N 阈值或超 B 双触发**，优先保留 K 条近期原文；无法一次总结时按顺序分批滚动，生成完重新预算检查；不可漏总结而静默丢尾部。
- [ ] C5. Summary 作为 compaction Entry（ext_data.summary 标记），记录 coveredThroughEntryId、生成调用记录；**摘要在 User 入库前完成**，两者使用本轮同一 run_id，逻辑历史为「最新 Summary + 未覆盖叙事 + 当前 User」。
- [ ] C0. 验证 JS/EJS 隔离环境、版本与 API，实测本地部署的超时、CPU/内存/输出限制；实现三作用域并发冲突回滚、世界卡首页 Global 更新、Run 临时变量隔离与销毁。
- [ ] C0a. 独立实现 StateReader / 隔离 JavaScript 与 EJS Runtime、ContentActivation、TextRenderer 和 TextTransform；预览与执行复用契约，预览仅修改隔离工作状态并丢弃，返回来源诊断。
- [ ] C6. AgentContext 独立读取全量 Raw 父链与最新有效 State，使用独立 ContentActivation 在压缩前一次匹配 lorebook/角色/状态根；关键词与 JavaScript when(三作用域状态) AND。
- [ ] C7. 七系统 NodeBuilder 和自定义文本节点有序执行，脚本可更新工作状态，worldState 本体占位并在全部普通 Prompt 后只读最新状态填回；TextRenderer 只渲染模板片段，TextTransform 按场景独立配置，历史/用户原话不二次执行；完成 ModelMessage[] Token 校验。
- [ ] C8. AgentRuntime 正常持久化所有 Pi 完整消息及技术 Entry；下一次模型历史不重放旧工具消息。
- [ ] C9. StateEngine 将模型的 Message 部分变更合并至脚本更新后的完整工作状态，Run 成功时原子提交三作用域最终值；终止 submit_turn 只有 narrative 时补规范化 Assistant Entry，不丢原始工具调用结果。

## 4. 阶段 D：页面与 API

- [ ] D1. WorldCard 编辑、开局/角色选择、lorebook 条目和状态加载；只露出 window/summary 参数。
- [ ] D2. Preset 模型与**仅两个字段**的 Token 预算 UI、状态模式、摘要 Prompt、七节点/自定义节点编排；Provider API Key 独立设置。
- [ ] D3. Session 历史请求使用 **Run 游标**，UI 消息投影只展示 user/assistant 叙事，原始 ToolCall/ToolResult 仅开发者调试可查；Root/Fork-only 按用户 Run 计数。
- [ ] D4. State 展示完整状态与 reason；当前 Schema 不兼容时保留状态，提示明确选择及备份后处理。
- [ ] D5. Context Preview 必须展示策略、最终叙事条数、Token 预算 B、实际估算、被裁历史条数、Summary 覆盖范围和最终 lorebook 命中；预览展示冻结 Prompt、压缩前候选命中和压缩后最终历史，保持与真实请求一致。
- [ ] D6. [领域 API](../design/domain-interfaces.md) 按真实用户操作定义：World 详情一接口包含开局/角色、Session 公开接口按业务收敛、Provider 列表包含配置状态、Preset 只用 getPreset、不暴露 snapshot/restoreDefault。

## 5. 验收

- [ ] E1. SQLite 六表可建；三类 Entry type、run_id、role、state 和 ext_data 约束和索引正确，世界删除级联关联 Session/Entries；所有 Pi Message 原始内容可还原。
- [ ] E2. 连续多次运行含 ToolCall/ToolResult 时，limit=10 精确计 10 个 Run、不拆 Run；跨分支相同 run_id 只查当前祖先。
- [ ] E3. Summary 物理附在本轮 User 之前，逻辑前置到历史，coveredThroughEntryId 准确；失败不写未验证的摘要。
- [ ] E4. Window 超 Token 时只裁剪历史、不重匹配；Summary N/Token 双触发；系统 + User 超限明确失败，不静默更改策略或截断用户输入。
- [ ] E5. Current State 独立、Schema 不兼容时保留并提示处理；关键词扫描与真实历史同源、when 读全量 State；role/order、Pi 请求中当前 User 仅一份。
- [ ] E6. 世界卡和预设 JSON 示例、Markdown 内部链接、SQLite DDL、级联世界删除与角色与 Entry 类型约束、端到端分支/分页测试通过。

**暂不做**：Android/Desktop、云端内容平台、多用户分布式锁、无隔离执行 JS/EJS、世界卡历史版本、自定义 Provider、独立 runs 表或旧消息删除。