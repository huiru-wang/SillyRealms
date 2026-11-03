# 技术架构：Session + Entry → AgentContext → Pi → Entry

> 2026-11-03 第二版目标设计，**尚未实现**。本地单人客户端，React/Vite/TypeScript H5 + Hono/TypeScript Server + SQLite + Pi Agent/Pi AI。参考 Fanto 的简单 Agent 组织与 `sessions/entries` checkpoint 思路，但世界分叉和生成尝试由 SillyRealms 的 Entry 模型明确承载。

## 1. 最少模块

- **World Domain**：世界卡内容、Opening、角色、世界书、状态 Schema、导入导出。
- **Preset Domain**：有序节点 `nodes[]`、CRUD/导入导出、`getPresetSnapshot()`。
- **Provider Domain**：保留 `ProviderService` 查询 Pi 内置 Provider/模型、用户 API Key 配置、模型选择/能力检查；不为每个 Provider 写适配器。
- **Session Domain**：`sessions/entries` 数据访问、会话创建、Entry 分叉树、Run 尝试列表、全量状态读取、摘要压缩和世界线 UI 查询。
- **State Domain**：全量快照、状态根加载条件、受限 ChangeSet、工具定义/内联解析与验证；状态更新后写到当前 Entry 选中 Run。
- **Shared Text Domain**：变量、条件、状态引用和受控文本转换；同时服务 Agent Prompt、世界卡详情和状态栏。**不放在 agent/context**。
- **Agent**：`AgentContext` 完整构建模型 messages；`AgentRuntime` 唯一执行入口；PiExecutor 执行与 SSE。

不要再设计 `WorldInstanceContext`、`RunService`、`MessageService`、`run_tool_calls` 表、缓存生命周期或多层 Agent Harness，复杂度要与本地单人业务规模匹配。

## 2. 建议目录

~~~text
src/
  domain/
    world/                 world-service.ts
    preset/                preset-service.ts
    provider/              provider-service.ts, credential-store.ts
    session/               session-service.ts, worldline.ts
    state/                 state-service.ts, state-engine.ts
    text/                  text-renderer.ts, expressions.ts, transforms.ts
    tag/                   tag-service.ts
  agent/
    agent-runtime.ts
    context/
      agent-context.ts
      world-book.ts
      node-builders/
        index.ts
        main.ts
        persona-info.ts
        character-info.ts
        world-state.ts
        chat-history.ts
        user-input.ts
        post-history.ts
        custom-text.ts
    pi/
      models.ts
      executor.ts
      events.ts
    tools/
      state-update.ts
  routes/
    sessions.ts
    agent.ts
    worlds.ts
    presets.ts
    providers.ts
  infrastructure/
    database/
~~~

目录是建议拆分，不强制每个文件引入独立抽象接口。系统 NodeBuilder 保持可扩展，每个仅负责自己节点的正文，按 `before → body → after` 合并，统一由共享 TextRenderer 处理。

## 3. 单轮 Agent 数据流

~~~mermaid
flowchart TD
 UI[H5: 输入 / 分叉 / 重试] --> Runtime[runAgent]
 Runtime --> Session[SessionService: Session + Entry]
 Session --> DB[(SQLite: 6 张业务表)]
 Runtime --> Context[AgentContext.create]
 Context --> H[按分支读取历史: 最近摘要 / N 条消息]
 Context --> S[沿父 Entry 读取最近全量状态]
 Context --> L[世界书与状态 Module 条件筛选]
 L --> I[WorldBook anchor/position/order 索引]
 I --> N[Preset nodes + 各系统 NodeBuilder]
 N --> Render[共享 TextRenderer]
 Render --> Messages[ModelMessage array]
 Messages --> Pi[PiExecutor + ProviderService]
 Pi --> SSE[SSE to H5]
 Pi --> State[StateEngine: 校验状态变更]
 State --> Session
~~~

### Session 创建

`createSession({worldId,openingId,userCharacterId,presetId,modelSelection})` 校验世界卡、Opening 与可玩角色、Preset 和 ProviderService 模型/API Key；复制 `worlds.data_json` 到 `sessions.world_snapshot_json`，创建 Root Opening Entry（S0 为 Run 的 stateSnapshot），设置 `active_entry_id`。用最小 SQLite 事务写两个表即可。

### 一轮 Prompt

~~~ts
async function runAgent(input: RunInput, emit: Emit) {
  // 同一个 Session 同时仅允许一个运行中的生成；重试沿用原 Entry
  const entry = await sessionService.startTurnOrRetry(input);
  try {
    const context = await AgentContext.create({
      sessionId: input.sessionId,
      parentEntryId: entry.parentEntryId!,
      userInput: entry.text,
    });

    const messages = await context.buildMessages();
    const session = await sessionService.getSession(input.sessionId);
    const model = providerService.resolveModel(session.modelSelection);
    const tools = stateService.createToolsIfSupported({
      model, activeModules: context.activeStateModules,
      stateMode: session.options.stateUpdateMode,
    });

    // prompt(...) 为本项目封装的适配器，不是 Pi SDK 原始签名
    const result = await piExecutor.prompt({model, messages, tools, emit, signal: input.signal});
    const state = stateService.applyAndValidate(context.fullState, result.stateChanges);
    await sessionService.completeEntryRun(entry.id, result, state);
    emit({type: "done"}); // 仅成功写入后
  } catch (error) {
    await sessionService.failEntryRun(entry.id, error);
    emit({type: "error"});
  }
}
~~~

具体模型流使用 Pi 内置 `builtinModels({credentials})`，不重新实现 Provider 协议。Pi toolCall/toolResult 可保存在 `entry.runs_json[].piEntries`，不用独立表；流式 token 不逐条写库，状态变更在完整输出验证后一次结算。失败 Run 保留便于同一 Entry 重试。

## 4. AgentContext 的精确执行顺序

1. 读取 Session + 实际 parentEntryId（不是全局最新 Entry）。
2. 读取本分支历史，保留最近 Summary 作为前缀，按近 N 可见消息窗口截取其后的完整回合。
3. 沿当前分支找到最近成功 Run 的**完整 stateSnapshot**；此查询**不受**摘要/N 条裁剪影响。
4. 由历史+当前 User 关键词与**全量状态**同时匹配世界书和状态 Module 条目：always、关键词、手动选择、when。
5. 世界书命中按系统节点 anchor/position 分组，条目按 `order` 升序和原始位置稳定排序。
6. 获取最新预设 `nodes[]`；逐个执行系统 NodeBuilder / 自定义 NodeBuilder，每个系统节点拼 before/body/after。
7. 所有 NodeBuilder 完成后共享 TextRenderer 统一变量/条件/状态引用/受控文本转换，生成有序 `ModelMessage[]`。

`StateService` 可用同一个 `context.activeStateModules` 生成受限状态更新工具，避免 Prompt 看见的状态范围与工具能写的状态范围不同。

## 5. 分叉、压缩与状态

`entries.parent_entry_id` 构成真正的世界线。继续 = 当前叶子下新增 Entry；从历史行动改选 = 在历史 Entry 的父节点下新增兄弟 Entry；最多 3 个直接互动子节点。世界线 UI 只显示 Root/Fork，其余折叠成边，计数对象是互动 Entry，不是模型内部 Run/消息。

`kind=summary` 的 Entry 是历史压缩锚点，保存文字摘要与继承完整状态。Agent 模型历史在最近 Summary 处停止，旧历史仍可查看/分叉；`history.max_messages` 表示近 N 条模型可见消息，`scan_depth_entries` 限制关键词扫描深度，三者不要混淆。

## 6. 本地个人应用的实现约束

**必须做**：主键/引用合法、状态不混分支、同一 Session 不同时生成两条响应、SQLite 两行初始化不半写、API Key 不泄露、Pi 最终 role/order 不被无声破坏。

**先不做**：通用 requestId/generationId、复杂乐观并发修订、分布式锁、缓存失效系统、增量世界线物化、独立工具审计表、多端 Session 同步和超复杂 Token 预算。SQLite 的短事务仍用于关键多行原子操作，这是基本数据完整性，不是过度设计。

2026-11-01 Pi SDK mock 实验已观察到后置 system 可能被 OpenAI-compatible 重排，`prompt(text)` 也会处理其当前 User。生产集成仍需对真实 HTTP 消息序列、SSE、取消及可选状态 Tool 做 PoC，不能直接把示意 `piExecutor.prompt({messages})` 认作 Pi 公共 API。

## 7. 文档与 API

- `GET /providers`、`GET /providers/:id/models`、`PUT/DELETE /providers/:id/api-key`、连接测试。
- `GET/POST /worlds`、`GET/POST /presets`、相关导入导出和编辑 API。
- `POST /sessions`、`GET /sessions/:id/entries`、`POST /sessions/:id/entries`、`POST /sessions/:id/forks`、`POST /sessions/:id/entries/:entryId/retry`、`GET /sessions/:id/worldlines`、`PUT /sessions/:id/active-entry`。
- `POST /sessions/:id/agent-context/preview` 返回本轮 Messages/必要诊断，不调用模型；`POST /sessions/:id/chat` 或上述 Entry 的 SSE 入口按服务路由惯例确定。

权威协议：[AgentContext](../design/agent-context.md)、[Text Rendering](../design/text-rendering.md)、[Session/Entry](../design/session.md)、[Storage](storage.md)、[State](../design/state.md)。
