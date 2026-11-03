# 技术架构：Session → Metadata → Messages → Pi Agent → SQLite

> 2026-11-03 精简目标方案，**尚未实现**。目标技术栈为 React/Vite/TypeScript（移动 H5）、Hono/TypeScript（本地服务）、SQLite（唯一权威存储）、Pi Agent/Pi AI（模型运行底座）。详细业务契约见 [Preset](../design/preset.md)、[Provider](../design/provider.md)、[WorldInstanceContext](../design/world-instance-context.md)、[AgentContext](../design/agent-context.md)、[Session](../design/session.md)、[State](../design/state.md)。

## 1. 核心边界

- **Session Domain**：创建 Session，保存已选 Opening、角色、世界卡快照、Preset ID、模型选择、当前叶子；管理 Run/Message/工具执行记录/状态快照、历史父链、分叉/重试/世界线。SQLite 唯一事实来源。
- **Preset Domain**：节点配置、CRUD、导入导出与 `getPresetSnapshot(id)`；不拼模型请求。
- **Provider Domain**：**必须保留 `ProviderService`**，统一查询 Pi 内置支持的供应商/模型、用户 API Key 的安全配置/删除/测试、模型选择及能力校验；不再写每 Provider 独立 HTTP Adapter。
- **State Domain**：初始状态、按同一父状态选择本轮可见范围、状态更新工具 Schema/内联协议、ChangeSet 校验及完整快照结算；不拥有 Agent 运行态。
- **Agent Runtime**：唯一模型执行编排入口 `runAgent`。`WorldInstanceContext` 是每轮从 Session 加载的普通 metadata；`AgentContext` 是输出 `ModelMessage[]` 的纯构建逻辑；`PiAgentExecutor` 将已构建消息接入 Pi 并转发 SSE。
- **没有独立 WorldInstanceContextService**、常驻世界实例、Context 缓存失效框架或第二套 Pi Session 持久化。

## 2. 目录建议（参考 Fanto，但不搬运完整 Harness）

~~~text
src/
  domain/
    world/              world-service.ts, world-repository.ts
    preset/             preset-service.ts, preset-repository.ts
    provider/           provider-service.ts, credential-store.ts
    session/            session-service.ts, session-repository.ts, worldline.ts
    state/              state-service.ts, state-engine.ts
  agent/
    agent-runtime.ts    # 唯一执行入口
    context/
      world-instance-context.ts
      agent-context.ts
      world-book.ts
      template.ts
    pi/
      models.ts         # Pi builtinModels({ credentials })
      executor.ts       # Pi Agent / Pi AI 请求适配
      events.ts         # Pi 事件转 SSE
    tools/
      state-update.ts   # 只调用 State Domain，不写库
  routes/
    sessions.ts
    agent.ts
    worlds.ts
    presets.ts
    providers.ts
  infrastructure/
    database/
~~~

这里只是**模块边界示意**；不强制每个 Service 再复制多层接口/Registry。世界线在 Session Domain，模型列表/API Key 在 Provider Domain，动态 Prompt 在 Agent Context，模型 IO 在 Pi。

## 3. 依赖图

~~~mermaid
flowchart TD
  UI[H5] --> Routes[Hono Routes]
  Routes --> Session[SessionService]
  Routes --> Provider[ProviderService]
  Routes --> Preset[PresetService]
  Routes --> Runtime[runAgent]
  Runtime --> Session
  Runtime --> Meta[loadWorldInstanceContext]
  Meta --> Session
  Meta --> Preset
  Meta --> Provider
  Runtime --> Scope[StateService: 选择本轮状态范围]
  Runtime --> Context[buildAgentContext]
  Meta --> Context
  Scope --> Context
  Runtime --> Executor[PiAgentExecutor]
  Provider --> PiModels[Pi builtinModels + CredentialStore]
  PiModels --> Executor
  Runtime --> State[StateEngine: ChangeSet 校验]
  State --> Session
  Session --> SQLite[(SQLite)]
~~~

Domain 不 import Agent Runtime；Agent 调用领域 Service；ProviderService 不 import Preset/WorldBook；PiExecutor 不了解 SQLite/world-card 业务；AgentContext 不依赖 CredentialStore。

## 4. Session 创建与每轮执行

### 4.1 创建世界实例

`createSession(worldId, openingId, userCharacterId, presetId, modelSelection)`：

1. 校验已发布世界卡、Opening、可扮演角色、存在且可用的 Preset；通过 `ProviderService` 校验模型受支持且用户已配置必要凭据（需要真实连通性时显式测试，不将本地存在当作云端有效）。
2. 在**一个 SQLite 短事务**保存 Session（世界卡完整快照、所选角色快照、Preset ID、模型选择、状态 Schema/Hash、Opening ID 等），创建 Opening Root Run、初始 Assistant Message、完整状态 S0，设置活动叶子。
3. 创建完毕不启动独立常驻 WorldInstanceContext。之后每轮依据 Session 数据加载。

### 4.2 一轮用户输入

~~~mermaid
sequenceDiagram
 participant UI as H5
 participant A as runAgent
 participant S as SessionService
 participant DB as SQLite
 participant W as loadWorldInstanceContext
 participant C as buildAgentContext
 participant P as ProviderService + Pi
 participant T as StateEngine
 UI->>A: sessionId + userText + expectedLeaf + requestId
 A->>S: 校验用户/父 Run/分支/状态、预占执行权
 A->>W: 从 Session 加载本轮 metadata
 W->>S: 世界快照/角色/父 Run 全快照
 W->>P: 解析当前 ModelSelection
 A->>S: 原子 startRun
 S->>DB: child Run(awaiting_ai) + User Message + 继承父快照
 A->>S: getAncestorRuns(parentRunId)
 A->>T: 对同一输入/父状态选择一次 StateScope
 A->>C: metadata + history + input + StateScope
 C-->>A: ModelMessage[]
 A->>P: 模型 + messages + 可选状态 tools
 P-->>UI: SSE 文本和工具事件
 P-->>A: 完整响应/候选状态变更
 A->>T: 校验 ChangeSet + 生成完整 S'
 A->>S: completeRun(runId, generationId, result)
 S->>DB: 短事务提交 Assistant + 新状态/状态标记
 A-->>UI: 仅提交成功后 done；否则 error/stopped
~~~

`startRun` 和 User Message 必须在调用外部模型之前持久化；失败/取消时保留同一 awaiting_ai Run 供重试，不保存半截 Assistant。成功后一次短事务完成 Run 结算、Assistant Message、有效状态快照和生成幂等校验。Pi 工具调用的开始/结果可按 toolCallId/generationId 幂等持久化至 `run_tool_calls`（限制/脱敏参数与结果），但不当作玩家可见 Message，也不在工具执行时直接提交状态。SSE token delta 不逐 token 写 SQLite。

**分叉与并发**：正常继续从当前有效叶子创建子 Run；历史新分叉从指定旧 Run 的父 Run 创建兄弟 Run。加载 metadata 必须绑定实际 `parentRunId`；运行期间保留选中父状态和生成 ID，落盘时校验父状态/Schema/Run 状态等，防止迟到响应写错世界线。预占同一 Session/Run 的并发执行，取消/失败释放。

### 4.3 运行编排伪代码

~~~ts
async function runAgent(input: RunRequest, emit: StreamEmitter) {
  const reserved = await sessionService.reserveRun(input); // 鉴权/父 Run/幂等/串行
  try {
    const metadata = await loadWorldInstanceContext(input.sessionId, reserved.parentRunId);
    const model = providerService.resolveModel(metadata.modelSelection);
    const run = await sessionService.startRun(reserved, input.userText);
    const history = await sessionService.getAncestorRuns(input.sessionId, reserved.parentRunId);
    const stateScope = stateService.selectScope(metadata, history, input.userText);
    const messages = await buildAgentContext(metadata, {
      userMessage: input.userText, ancestorRuns: history, stateScope
    });
    const tools = stateService.buildToolsIfSupported(metadata, model, stateScope);
    const result = await piExecutor.prompt({ model, messages, tools, emit, signal: input.signal });
    const settled = stateService.settle(metadata, stateScope, result);
    await sessionService.completeRun(run.id, reserved.generationId, settled);
    emit({ type: "done" }); // 仅成功提交后
  } finally {
    await sessionService.releaseRun(reserved);
  }
}
~~~

伪代码仅展示编排边界，细节如重试已有 awaiting_ai Run、内联解析、错误/超时/取消、SSE 连接关闭和 generationId 校验仍需实现。`stateService.selectScope` 不必做成框架：一份只读选择结果让 WorldState Prompt 与工具 Schema 共用；`off` 模式可跳过。

## 5. Pi 的职责与已知限制

使用 Pi 内置 `builtinModels({ credentials })` 获取 `getProviders/getModels/getModel/getAvailable` 与模型认证、运行能力；本项目只维护产品允许列表和凭据管理服务，不重写每家 Provider HTTP/错误/流式协议。`PiAgentExecutor` 统一适配 SDK 的 prompt、事件、取消和消息格式。无状态工具时 `tools=[]`；允许状态更新时才提供受限的 `state-update`/`submit_turn`，绝不默认暴露 Shell/文件工具、用户扩展或自动技能。

**PoC 事实，不能越过**：2026-11-01 的 `@earendil-works/pi-coding-agent@1.4.0` 本地 mock 实测支持 `prepareRequest` 覆盖消息、SSE/abort，但 OpenAI-compatible 会把历史后的 `system` 消息规范化到开头。`prompt(userText)` 也可能自行附加 User。实际接入必须验证最终 HTTP role/order、Prompt 预览一致性、User 去重、额外 system/cwd 内容；必要时选择 Pi 更底层公共接口，不能声称数组参数直接被 SDK 接收，也不能静默改变角色语义。真实 Provider/复杂 Tool 流式及 SQLite 端到端尚未验证。参考 [实验报告](../../experiments/pi-sdk-feasibility/REPORT.md)。

## 6. 功能与验证边界

- AgentContext 只返回 messages，不负责状态工具契约；Preset 是配置，Provider 是模型与凭据，State 是更新协议和结算。
- Token 预算首期只做必要消息保护、基于完整 Run 的连续历史裁剪和上限错误；不引入多层 TokenBudget/NodeBuilder 采纳框架。
- 世界书命中与状态根选择按本轮真实祖先历史计算；禁止跨分支读取和从 UI 分页拼模型历史。
- 原有状态 Tool/内联协议可选，但模型能力需实测，未知模型默认不开复杂工具或明确报不支持；不在失败时把非法状态默认为无变化。
- 全局世界线 Root/Fork-only 压缩计算归 Session；不属于 WorldInstanceContext，不要求 MVP 先实现增量图缓存。
- MVP API 包括世界卡、Preset、`GET /providers`、`GET /providers/:id/models`、`PUT/DELETE /providers/:id/api-key`、测试连接、Session/Run/分叉/状态/SSE/Context Preview。API Key 不回显。

实施任务见 [implementation-plan.md](implementation-plan.md)。
