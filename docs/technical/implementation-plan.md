# SillyRealms 精简架构实施计划

> 2026-11-03 目标方案，**尚未正式实现**。本计划和工作区 `plan/sillyrealms-domain-refactor-tasks.md` 同步；唯一协议仍在 `docs/design/*` 与 `docs/technical/*`。不再执行旧「双 Context 缓存服务 + 独立 Provider Adapter」任务清单。

## 0. 已确定决策

| 模块 | MVP 约定 | 不做/延期 |
| --- | --- | --- |
| WorldCard | 发布世界卡、Opening、角色可扮演约束、世界书与状态定义 | 运行时自动合并不同版本 |
| Session/Run | Session 保存世界快照、玩家身份、Preset ID、模型选择；Run 父链/可见 Message/全状态快照 | Pi JSONL 作为第二数据权威 |
| Preset | 七系统节点唯一、任意文本节点、role/顺序/预算、CRUD/导入导出 | 执行 Provider/内部 Prompt 构建 |
| Provider | **ProviderService 保留**：列出 Pi 内置受支持模型、Key 保存/删除/验证、解析模型与能力 | 每 Provider 单独 HTTP Adapter、用户自定义 Provider/URL |
| WorldInstanceContext | 每轮从 Session/相关领域加载 metadata 普通对象 | service open/refresh/invalidate、缓存索引、拓扑管理 |
| AgentContext | `buildAgentContext() → ModelMessage[]`；世界书、模板、预设节点编排、完整 Run 历史裁剪 | NodeBuilder 注册框架、复杂 TokenBudget、返回大型 Result 对象 |
| Agent Runtime | `runAgent` 唯一入口，PiAgentExecutor 负责模型调用与 SSE | 另一套常驻 Session Runtime、隐式 Coding Tools |
| State | 同一父 Run 状态/一次状态范围选择、可选工具或内联更新、ChangeSet/全快照原子结算 | Context 内直接持久化状态 |

## 1. 分阶段可执行任务

### A. 最小真实 PoC（阻塞大规模实现）

- [ ] A1. 锁定兼容的 Pi Agent/Pi AI 版本，验证 `builtinModels({ credentials })` / `getProviders/getModels/getModel/getAvailable` / CredentialStore 数据读取和调用。
- [ ] A2. 验证完整 `ModelMessage[]` 如何进入 Pi 的最终 HTTP 请求：`prepareRequest` 或更底层受支持接口；专测后置 system/user、自定义 role、重复 User、Pi 自动增加 cwd/system、历史分支顺序。对不支持的组合明确报错。
- [ ] A3. 验证模拟和至少两家真实 Provider 的 Key、模型选择、SSE、取消、长叙事、Tool Call；记录哪些模型可选状态工具，不能用的改内联模式或报不支持。
- [ ] A4. 定义最小 `Run/Message/Session/ModelSelection/StateScope` 类型与父链查询、凭据错误类型；暂不搭缓存和 Registry 框架。

### B. 持久化与 Domain

- [ ] B1. 建 `worlds / sessions / runs / messages / run_tool_calls / presets / app_settings / provider_credentials` 逻辑存储；写 Session 创建事务：世界快照+所选角色+Opening Root+初始 S0。
- [ ] B2. `SessionService`：鉴权、有效叶子/历史父链、`startRun` 幂等（awaiting_ai+User+父快照）、`completeRun` 短事务（Assistant+有效状态）、同 Run 重试、分叉/编辑/切叶子。
- [ ] B3. `PresetService`：七节点校验、配置 CRUD、导入/导出、只读 `getPresetSnapshot`；沿用现有 `docs/examples/default-preset.json` 契约。
- [ ] B4. **`ProviderService`**：从 Pi 模型目录映射列表、产品允许列表、用户 Key CredentialStore 安全 CRUD、`getAvailableModels`、显式连接测试和 `resolveModel`；默认/Session 模型选择。
- [ ] B5. `StateService/StateEngine`：根状态初始化、Scope 选择、类型/ChangeSet 校验、工具/内联状态提取及完整快照结算。

### C. 单轮 Agent 运行链

- [ ] C1. `loadWorldInstanceContext(sessionId, parentRunId)`：直接读取 Session 世界快照、玩家身份、Preset、模型选择、父 Run 状态等，**不设计服务生命周期或缓存**。
- [ ] C2. `buildAgentContext(metadata, { userMessage, ancestorRuns, stateScope })`：世界书触发和前后挂钩、变量/状态只读模板、按 `nodes[]` 保序拼装、历史只从真实父链加载，返回 `ModelMessage[]`。
- [ ] C3. 最简 Token 裁剪：当前输入/必需状态/协议保留，历史从远到近按完整 Run 移除；必要内容仍超上限则拒绝。
- [ ] C4. `PiAgentExecutor`：模型与凭据由 ProviderService/Pi 解析，按实际接口适配有序 Messages、可选状态工具、SSE 事件和取消；工具调用开始/结束持久化到受限的 `run_tool_calls`（非聊天消息），默认不暴露编码工具。
- [ ] C5. `runAgent`：串行预占、加载 metadata、startRun 保存 User、查询祖先/一次状态范围、build messages、Pi 执行、状态结算、completeRun 保存 AI、发 done；错误/取消保留 awaiting_ai 并释放预占。

### D. 产品页面与联调

- [ ] D1. 世界卡、Preset、Provider 配置页（可用模型、API Key 配置状态/删除/显式连接验证）。
- [ ] D2. Chat SSE、Run 分组分页（最近约 30 Run）、同 Run 重试、历史分叉、切换叶子。
- [ ] D3. Root/Fork-only 压缩世界线：从 Run 元数据按需计算，不引入 WorldInstanceContext 图缓存。
- [ ] D4. 状态独立面板和 Context 预览；预览走相同 `buildAgentContext` 路径，不暴露 Key/原始机密。

### E. 验证、风险与回退

- [ ] E1. 模块测试：Provider 列表/未知 ID/Key 脱敏、Preset round-trip、WorldBook/模板、System Node role、历史分叉与 User 去重、历史 Run 裁剪。
- [ ] E2. SQLite/Pi 端到端：世界卡→Session/Opening→发送→SSE→Assistant+状态落盘→重启恢复；失败/取消/重复 requestId/重复 generationId/同 Run 重试。
- [ ] E3. 状态工具/内联失败、ChangeSet 原子回滚、1000+ Runs 父链/分页/压缩世界线/编辑 stale 与跨世界线隔离。
- [ ] E4. 数据迁移前一致性备份、dry-run 和回滚；旧 Entry/旧状态世界卡按显式转换处理，不悄悄覆盖用户内容；PoC 未通过前不宣称已实现。

## 2. 验收门槛

1. **真实请求**：最终 HTTP 上的 role/order 与业务支持范围一致；无法表达的配置必须显式报错，Pi 自动追加的 User/cwd/system 不得意外重复。
2. **唯一权威**：SQLite Session/Run/Message/State 为权威，`run_tool_calls` 只记录内部执行事实；Pi 临时 Session 不形成第二套权威；失败/取消可准确重试。
3. **Provider Service**：确实能列出支持的模型、区分认证完整与远端验证、管理用户 API Key；不维护多个重复 Provider Adapter。
4. **状态一致性**：同一 `StateScope` 为 Prompt/工具共用，状态工具只是候选变更，结算前不改数据库，失败不部分提交。
5. **边界简洁**：无 WorldInstanceContextService、Context/世界线缓存失效框架、7 NodeBuilder 注册表或多余的多层 Runtime。
6. **Session 产品**：Opening 仅一次、Run 祖先分页/分叉正确、Root/Fork-only 压缩边计数正确、重启后恢复。

## 3. 设计范围声明

本轮仅更新设计文件；尚未创建服务端代码、迁移 SQLite、配置真实 Key 或调用收费模型。PoC 实测见 [已有报告](../../experiments/pi-sdk-feasibility/REPORT.md)，其结论仅覆盖所测 SDK 版本及本地 mock；未来能力要以固定版本下的真实验证为准。

文档入口：[架构](architecture.md)、[存储](storage.md)、[Provider](../design/provider.md)、[AgentContext](../design/agent-context.md)、[WorldInstanceContext](../design/world-instance-context.md)、[Session](../design/session.md)、[State](../design/state.md)。
