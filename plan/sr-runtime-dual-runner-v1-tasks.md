# SRRuntime 与双 Runner 实施任务 v1

> 日期：2026-11-12。全部实施任务待执行。
> 技术方案：[sr-runtime-dual-runner-v1.md](./sr-runtime-dual-runner-v1.md)。
> 本清单供后续授权实施使用；当前只创建文档，不代表已执行代码变更、迁移或发布。
> 后续执行顺序以[架构 v2 任务清单](./sr-runtime-context-architecture-v2-tasks.md)为准，本清单保留为历史设计记录。

所有任务由当前单一 Agent 负责执行、验证与复查，不委派子代理。

## 1. 顺序与依赖

```mermaid
flowchart LR
    S1[S1 验证与契约] --> S2[S2 机械改名]
    S2 --> S3[S3 共用最终化]
    S3 --> S4[S4 模式配置与准备]
    S4 --> S5[S5 Direct 执行]
    S5 --> S6[S6 API SDK 历史]
    S6 --> S7[S7 UI 与默认切换]
    S7 --> S8[S8 集成验收与文档]
```

S2 的机械改名不依赖 S1 的 Provider 支持结论，可按任务需要调整先后顺序；进入 S5 和启用 Direct 默认之前，必须验证至少一个目标组合。S5 的纯解析器可在 S1 契约稳定后先行处理，但最终集成仍依赖 S3/S4。各项工作由当前 Agent 依次完成。

## 2. 八个实施步骤

### S1：验证模型调用路径并固定契约

- [ ] 重新核对 git status、基线、数据库版本、API/SDK 消费者及原有测试。
- [ ] 通过 mock transport 验证选定 provider/model/adapter 的最终请求；查明后置 system 支持证据，不调用真实付费模型。
- [ ] 固定 Direct/Agent 的 mode、PreparedRun/执行结果边界、失败与停止策略。
- [ ] 固定当前工具基线旧会话保留 Agent、新会话默认 Direct、其他来源版本的迁移分流、会话级模式及 busy 规则等建议决策。
- [ ] 明确恢复 interrupted 的公开映射、摘要缺口元数据、phase 终态优先与统一错误码。

主要文件：现有 `apps/server/src/agent/model/`、`runtime/types.ts`，以及两个本方案文件。此阶段先交验证证据，不顺手重写 Provider 层。

完成条件：至少一个目标组合有可信支持依据和实际 payload 测试；不支持时记录具体阻断。配置/事务/API 不再留互相冲突的语义。

### S2：AgentRuntime 机械更名为 SRRuntime

- [ ] 类名改为 SRRuntime，`agent-runtime.ts` 改为 `sr-runtime.ts`。
- [ ] 同步 `agent/index.ts`、`app.ts`、`routes/session-runtime.ts`、`routes/state-updates.ts`。
- [ ] 更新直接导入旧类/文件的 runtime、usage、state-review-flow、session-runtime、state-updates 等测试。
- [ ] 保留当前 Agent 执行行为，不在本步接入 Direct、不搬迁整个 agent 目录。

完成条件：运行时仍通过现有 Agent 流程；搜索剩余旧标识，区分历史文档引用与执行代码；typecheck 和受影响回归通过。

### S3：收拢最终化、Usage 和占用释放

- [ ] 从 AgentRunner 移出最终状态提交、RunPostProcessor 调用、终态事件和 release。
- [ ] AgentRunner 返回带 mode 的执行结果，保留流式正文持久化和工具循环。
- [ ] SRRuntime 统一负责准备失败、执行失败、停止和事务异常收敛，确保没有重复终态。
- [ ] 保留 Agent stopped 保存工具 workspace 的现有政策，建立模式明确的提交策略入口。
- [ ] 事务后通知失败仍释放占用，不覆盖已提交终态；Usage 请求 journal 与 Run 结算保持幂等。

主要文件：`runtime/sr-runtime.ts`、`runtime/agent-runner.ts`、`runtime/types.ts`、`persistence/run-store.ts`、`runtime/run-post-processor.ts`。

完成条件：Agent 的成功/失败/停止/continuation、同世界互斥、去重、tip 冲突、数据库失败和 Usage 回归通过；最终化和释放各只有一个协调入口。

### S4：模式存储、冻结配置和两种上下文准备

- [ ] 增量添加 sessions.execution_mode；新建默认 direct，当前工具基线旧会话回填 agent，若 v2 已先上线则其旧会话回填 direct，已有模式保持；按来源版本分流，与 v2 能力列安排同批或后续版本，勿重复重置。
- [ ] 扩展会话 create/GET/列表/PATCH；非法值拒绝，preparing/running 禁止模式切换；异步校验后在写入前重查 busy，保持多字段更新原子性。
- [ ] 入场冻结 mode；用 DirectPreparedRun/AgentPreparedRun 判别联合约束调用。
- [ ] ContextManager 复用历史、激活和压缩，并分别构造 Direct 尾块 prompt 与 Agent 工具 prompt。
- [ ] Provider 支持预检早于摘要/生成调用；Direct 不支持不影响可用 Agent，也不自动切换。
- [ ] 能力摘要明确 Direct 专属配置在 Agent 中不适用；保留存储配置，不悄悄改变 Agent 工具政策。

主要文件：`infrastructure/database/database.ts`、`routes/sessions.ts`、v2 能力配置/API、`context/context-manager.ts`、`context/prompt-builder.ts`、`context/system-main.ts`、`runtime/types.ts`。

完成条件：临时数据库迁移与重复启动测试通过；配置快照不被运行中预设改动影响；模式分支无 prompt/工具污染。此时尚未就绪的 Direct 不得作为可发布默认入口；中间提交不部署到用户数据目录。

### S5：实现 DirectRunner 及 v2 扩展处理

- [ ] 实现有界流式 splitter、严格帧/JSON parser、状态和建议两个处理器。
- [ ] DirectRunner 调用 ModelClient 一次 generation，不传 tools/tool_choice，不执行工具、不自动续轮。
- [ ] 正文先保存再发布；原生思考和尾块不进入可见正文。
- [ ] 返回隔离 workspace、协议验证和扩展结果，由 Runtime 按 Direct 门槛最终化。
- [ ] 覆盖 partial、建议单独失败、缺失/损坏尾块、length/toolUse/断流、空正文、取消竞争和重复提交。

主要文件：`runtime/direct-runner.ts`、`narrative/`、`persistence/run-store.ts`、`domain/state/atomic-state.ts` 的复用边界。

完成条件：v2 协议矩阵通过 fake-provider/纯函数测试；Direct 无工具循环；Agent 原测试保持通过。对应 v2 T3/T4 及 T2 剩余 Direct prompt 工作。

### S6：补齐查询、历史、恢复和 SDK

- [ ] 建立统一公开投影，查询/分页/终态事件返回 executionMode 与匹配模式的结果；旧 Run 字段缺省。
- [ ] 恢复在途 Direct 的 pending/phase，内部 interrupted 对外一致映射，保留 disabled/not_required；已提交 Run 不被重处理。
- [ ] 摘要输入加入受控同步状态，压缩元数据保存有界缺口摘要；后续成功不得伪造旧缺口已修复。
- [ ] SDK/SessionRuntime/story-history/Host/frame 同步执行 mode 和 phase 契约；默认订阅兼容。
- [ ] 终态吸收旧阶段事件；入场即转发 preparing，会话 GET 返回 Runtime 提供的 activeRun 公开摘要；刷新、重连及 iframe 重载主动查询活动 Run 与权威历史，不能依赖 SSE 回放或仅查持久 entry 判断空闲。

主要文件：`domain/session/history-runs.ts`、`routes/session-runtime.ts`、`routes/sessions.ts`、`infrastructure/database/database.ts`、`context/history-compactor.ts`、`context/context-manager.ts`、SDK run-contract/session-runtime/story-history、Web host/frame。

完成条件：重启、HTTP/SSE 竞态、两模式切换后的连续历史与状态、默认订阅/卸载清理测试通过；无凭据、prompt、reason 或 raw 尾块进入公开 DTO。对应并扩充 v2 T5。

### S7：接入模式选择、能力界面和默认 Direct

- [ ] 会话设置提供 Direct/Agent 选择、当前模式、busy 禁用、旧会话兼容提示和保存失败状态。
- [ ] Direct 能力界面支持 v2 开关与下一轮生效；Agent 显示适用性说明，避免误导暂停状态工具。
- [ ] 预设编辑支持按模式解释布局，保留 Agent 旧布局的可维护入口；world warnings 使用模式明确的措辞。
- [ ] WorldStory 显示 Direct 扩展阶段、partial/失败提示，建议填草稿与撤销；活动 Run、当前 Agent 模式、过期 tip 禁用旧建议；仅切换后回到 Direct 且局面未变可恢复建议，刷新结果一致。
- [ ] 新会话默认 Direct 的入口在 S5/S6 可用后一起启用；目标模型不支持时明确提示，不自动调用 Agent。

主要文件：`apps/web/src/features/sessions/SessionSettingsDialog.tsx`、`features/presets/PresetPage.tsx`、`PresetLibraryPage.tsx`、`host.tsx`、`frame.tsx`、`packages/sr-sdk/src/world-story.tsx`、Host composer 与世界 warnings 消费者。

完成条件：375px/1280px 实际浏览器流程通过；草稿不会被异步结果或过期撤销覆盖；旧会话保持来源版本对应模式，新会话走 Direct。对应 v2 T6；人物候选 T7 不阻塞双 Runner 交付。

### S8：集成回归、文档与交付

- [ ] 双模式完成一次完整用户流程，并覆盖停止、失败、恢复、跨模式连续历史、迁移及能力不可用场景。
- [ ] 更新根/服务端 AGENTS.md、运行时技术文档、配置/API/SDK 契约和架构决策；同步 v2 中 Runtime/Runner 命名与模式适用范围。
- [ ] 清理旧历史描述的歧义，明确本期未实现 Skills、通用外部 Tools、动态插件系统；不要恢复用户删除中的决策文档。
- [ ] 复查后修复阻断问题，再运行受影响检查。

主要文件：相关 docs、AGENTS.md、v2 计划索引与双模式测试。

完成条件：下面的质量命令及实际测试入口覆盖可复现；遗漏和限制明确报告。提交、推送、发布、真实数据迁移或付费模型验收需另有明确授权。

## 3. 检查策略

实施前检查 scripts，按改动范围运行：

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:browser
```

当前根 lint/test 主要覆盖 Server，build 为 Web，不能据此宣称所有 SDK/Host 浏览器行为已覆盖。确认 SDK/Host 新测试被实际入口发现，必要时使用对应项目现有入口显式执行。

| 检查领域 | 主要现有入口/新增范围 |
|---|---|
| 旧 Agent 兼容 | runtime、atomic-flow、worldstory-run-flow、state-review-flow、usage |
| 模式与迁移 | database、world-session、world-config-refactor；新增 execution-mode 临时库测试 |
| Direct 协议 | splitter/parser/handlers 单测与 fake-provider 集成 |
| Provider | pi-poc 的 mock transport，新增无工具、后置 system、异常终止断言 |
| 状态与恢复 | 原有 state/atomic-state；新增两模式提交政策和恢复终态断言 |
| 历史与 SDK | history-runs、session-runtime、sdk-session-runtime、story-history |
| 摘要 | summary、context、roleplay-context；新增缺口元数据跨压缩测试 |
| 交互 | host-roleplay 和 composer/WorldStory 浏览器入口，模式选择与草稿保护 |

## 4. 范围与后续

本批不实现 v2 人物候选识别、不移除 Pi SDK、不搬迁整个 agent 目录、不增加第三种 Runner、不构建通用 Skills/插件系统。人物候选可以在核心验收后按 v2 T7 独立交付。

未来增加 Tools/Skills 时先定义权限、预算、超时和副作用处理，再接入 Agent 工具或准备阶段。双 Runner 交付完成不代表这些未来能力已经可用。
