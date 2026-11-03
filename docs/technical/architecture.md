# 技术架构：Monorepo + 消息级 Agent Entries + 单 AgentContext

> 2026-11-04 MVP 目标设计，尚未实现。本地个人客户端优先，首期实现 H5 Web + Server；Android、Desktop 暂不开发。技术栈建议 React/Vite/TypeScript、Hono/TypeScript、SQLite、Pi Agent/Pi AI。

## 1. Monorepo 结构

~~~text
SillyRealms/
├── apps/
│   ├── web/                       # 当前：H5 前端，React + Vite
│   ├── server/                    # 当前：Hono API + Pi Agent + SQLite
│   ├── android/                   # 以后：Android 客户端
│   └── desktop/                   # 以后：PC/Mac 客户端
├── packages/
│   ├── core/                      # WorldCard/State/Preset 的纯类型、只读表达式、共享 TextRenderer
│   └── shared/                    # 前后端 API DTO/错误/事件结构
├── docs/
├── package.json
└── pnpm-workspace.yaml
~~~

首期仅创建 `apps/web`、`apps/server` 以及实际需要的共享 package；未来平台目录可后续创建。不需要预先引入 Turborepo、跨平台 UI 框架或移动端原生基础设施。Server 是 SQLite/Provider Key/Pi 模型执行的唯一持有者，Web 不直接访问数据库。

## 2. 业务边界

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| WorldService | 世界卡唯一当前版本、角色/Opening、世界书、Context 策略、编辑/导入 | 世界快照和旧版本 |
| PresetService | 模型 ID/参数、状态模式、七系统节点与摘要 Prompt | API Key、模板执行 |
| ProviderService | Pi 内置模型列表/能力、API Key 安全管理、显式连接测试 | 重写每个 Provider Adapter |
| TagService | type/name/sort_order、按 type 排序；世界卡标签 ID 引用 | world_tags 关联表 |
| SessionService | Session/Raw Entry 读写、父树、分叉、UI 叙事分页、Summary Entry | 生成独立 Run 表或持久 Context |
| StateService | 完整 State Schema、根加载、带 reason 的 ChangeSet、校验结算/失效重置 | 把摘要当真实状态 |
| 共享 TextRenderer | 变量、条件、状态引用、只读变换，Web/Server 复用 | 任意来源 JS/EJS |
| AgentContext | 完整消息父链加载、叙事投影、WorldCard 上下文策略、条目筛选、NodeBuilder → ModelMessage[] | 工具消息删除、Pi SSE、重复存 Session 快照 |
| AgentRuntime/PiExecutor | 模型调用、SSE、取消、主轮**所有 Pi Message 按 Entry 持久化**、结果结算 | 旧 ToolResult 混入下一轮历史 |

## 3. Server 建议目录

~~~text
apps/server/src/
  domain/
    world/world-service.ts
    preset/preset-service.ts
    provider/provider-service.ts
    session/session-service.ts
    session/worldline.ts
    state/state-service.ts
    tags/tag-service.ts
  agent/
    agent-runtime.ts
    context/
      agent-context.ts
      narrative-projection.ts
      context-strategy.ts
      world-book.ts
      node-builders/          # 7 个系统节点 + 自定义文本节点
    pi/
      executor.ts
      events.ts
    tools/
      state-update.ts
  routes/
    worlds.ts
    presets.ts
    providers.ts
    sessions.ts
    agent.ts
  infrastructure/database/

packages/core/src/
  world/                      # WorldCard/State/Preset 类型和纯函数
  text/                       # 变量/when/状态引用/受控文本转换
packages/shared/src/
  api/
  events/
~~~

不要保留 WorldInstanceContext、WorldInstanceContextService 或旧 `agent/context/template.ts`。Prompt/WorldCard/UI 文本处理都使用独立的 core/text。

## 4. 一轮交互的真实数据流

~~~mermaid
flowchart TD
  UI[H5] --> Runtime[AgentRuntime]
  Runtime --> Sess[SessionService: Session + Raw Entries]
  Sess --> DB[(SQLite 六张表)]
  Runtime --> Ctx[AgentContext]
  Ctx --> World[WorldService: 当前 WorldCard]
  Ctx --> Preset[PresetService: model + prompt + summary]
  Ctx --> Raw[读取 parent_id 祖先原始 Agent 消息]
  Raw --> Projection[叙事投影: user/assistant text]
  Projection --> Window[WorldCard none/window/summary 策略]
  Ctx --> State[独立读取本分支最新完整 State]
  Window --> Match[世界书/状态条件命中]
  State --> Match
  Match --> Nodes[世界书索引 + 七 NodeBuilder]
  Nodes --> Renderer[共享 TextRenderer]
  Renderer --> Messages[ModelMessage array]
  Messages --> Pi[Pi Executor]
  Preset --> Pi
  Pi --> EntryWrites[依次存 user/assistant/toolResult Raw Entry]
  EntryWrites --> Sess
  Pi --> StateEngine[验证 reason + 状态变更]
  StateEngine --> Sess
  Pi --> UI
~~~

**读取和写入必须区分两种视图**：

- `getRawAncestorEntries`：全量原始 Agent Message，包含 Assistant ToolCall 内容和独立 ToolResult 消息，严格按真实 parent_id 读取。
- `narrativeProjection`：**只取 user/assistant 叙事文本**，供 Chat UI、下一轮模型历史与关键词匹配三处复用；StateUpdate XML、旧 ToolCall、ToolResult 不进入这三个消费者。

### 发送和生成

1. 取得 Session 的 world_id/preset_id/user_character_id/tip_entry_id，加载当前唯一最新世界卡和 Preset（其中关联模型）。
2. 以**原 tip（本轮 User 尚未入库）**读取完整 Raw 父链、叙事历史和最新全量 State。State 与当前 WorldCard Schema 不兼容时允许重置。
3. 按 WorldCard context.strategy 处理当前历史。若 summary 达阈值，先用 Preset.summary_prompt 和步骤 2 的全量 State 生成 Summary，**在原 tip 后追加 Summary Entry**，更新 tip 并记录 coveredThroughEntryId。Summary 逻辑上在保留消息之前，物理上追加在历史末尾。
4. **摘要完成后才写本轮 User Entry**，其 parent_id 指向原 tip 或刚生成的 Summary。模型历史中只追加本轮 User 一次；以本轮固定的叙事窗口 + 当前 User 匹配 WorldBook/状态根，when 读取步骤 2 的完整 State。角色支持 order，世界书按 anchor/position/order。
5. 执行预设节点的七个独立 NodeBuilder、统一共享模板渲染，得到 ModelMessage[]；由 Preset.model 通过 ProviderService 解析模型。
6. Pi 正常调用工具：将每个成型的 Assistant Message（含 ToolCall 块）、ToolResult Message、后续 Assistant Message **全部按 Entry 顺序持久化**，不存在“只存可见消息”的例外。SSE token delta 不是 Message，不用逐 token 落库。
7. 模型变更集每项必须带 reason，经 StateService 校验后把完整 S' 附在最终 Assistant Entry 中。若终止型 submit_turn 只在工具参数中提供 narrative 而没有独立的可见 Assistant 正文，适配层在验证成功后将 narrative **额外保存为来源明确的规范化 Assistant Entry**，原始 ToolCall/ToolResult 仍完整留存；已有最终 Assistant 正文时不得重复写。模型失败/中断保留既有工具历史，不把失败工具结果作为有效世界状态。
8. 下一轮重新构建 Pi 请求时，只使用**叙事投影后的 user/assistant 历史**，不恢复历史 ToolCall/ToolResult；本轮真正执行工具的消息交换仍正常。

## 5. 模型 Context 预算和 Pi SDK 约束

- none：全量叙事历史；超模型窗口给错误，不静默裁剪。
- window：最近 N 条叙事消息；原始消息照常持久化。
- summary：未被最近 Summary 覆盖的可见历史条数达到 N 时生成摘要，保留最新 K 条，将摘要作为逻辑历史前缀。摘要 Prompt 在 Preset 中，允许读取全量 State。
- 模型真实聊天历史、世界书关键词扫描的上下文**必须一致**；条件表达式 `when` 始终读完整 State，不从聊天历史推断。
- Mock PoC 提醒：Pi 对 OpenAI-compatible 的后置 system 可能重排，prompt(text) 可能额外追加 User。实际 HTTP 顺序与当前 User 去重必须实测，不假设 `piExecutor.prompt({messages})` 就是 Pi SDK 原生签名。

## 6. 数据量、并发与 API

SQLite 六表权威数据：`worlds / presets / provider_credentials / tags / sessions / entries`，不建独立 runs/messages/run_tool_calls 等表。用户本地应用只保留每个 Session 一个在途推理、必要的小事务和异常恢复；不提前设计分布式一致性或缓存修订矩阵。

MVP API：WorldCard/角色/Opening/标签/Context 配置，Preset/Provider 模型和 API Key、Session 创建与 Entry 分支/历史分页、世界线图、当前 State、Context Preview 和 Pi SSE。聊天读取为叙事投影，开发者调试可读取 Raw Entries（需注意隐私与 Key 脱敏）。

具体协议：[Session](../design/session.md)、[Context Strategy](../design/context-strategy.md)、[AgentContext](../design/agent-context.md)、[Preset](../design/preset.md)、[State](../design/state.md)、[Storage](storage.md)、[Implementation Plan](implementation-plan.md)。
