# 技术架构：Monorepo + Run 分页 + 完整 Agent Entries

> 2026-11-04 MVP 目标设计，尚未实现。个人本地客户端，首期 H5 Web + Server；建议 React/Vite/TypeScript、Hono/TypeScript、SQLite、Pi Agent / Pi AI。详细契约：[Session](../design/session.md)、[Context Strategy](../design/context-strategy.md)、[Storage](storage.md)。

## 1. Monorepo 结构

~~~text
SillyRealms/
├── apps/
│   ├── web/                    # React/Vite H5
│   ├── server/                 # Hono API + Pi Agent + SQLite
│   ├── android/                # 后续
│   └── desktop/                # 后续
├── packages/
│   ├── core/                   # WorldCard/State/Preset/共享表达式、加载判断和文本处理
│   └── shared/                 # 前后端 DTO、错误、事件
└── docs/
~~~

首期只创建实际需要的 Web/Server/core/shared，不提前引入跨端 UI 或分布式基础设施。Server 持有 SQLite、CredentialStore、Pi 执行；Web 不直连数据库。

## 2. 领域边界

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| WorldService | `getWorld` 返回含开局/角色的完整当前卡；增删改查/导入导出；删除世界时级联全部 Session/Entries/独占资产 | 世界快照和旧版本 |
| PresetService | `getPreset` 同时供编辑与本轮 Context 读取；管理模型 ID/两个 Token 上限、状态模式、七系统节点和摘要 Prompt | API Key/模板执行/独立快照 |
| ProviderService | 供应商/模型列表（含凭据配置状态）、保存或删除 Key、显式连接测试、Runtime 解析模型 | 重复的 hasApiKey/getModel/getAvailableModels 与 Provider 协议重写 |
| TagService | 标签字典和 type 内排序 | world_tags 关联表 |
| SessionService | 会话管理、按 run_id 的可见聊天分页、世界线查看/切换/重生/续写；Raw Entry 写入由内部 Repository 承担 | 独立 runs 表、外部 appendEntry API 或重复持久化 Prompt |
| StateService | 当前全量状态、带 reason 的变更和新 Schema 不兼容重置 | 通过摘要推断真实状态 |
| AgentContext | 真实父链→候选叙事→内容激活→NodeBuilder/渲染→完整 Prompt Token 校验→按需压缩历史 | Pi SSE、擅自丢旧 ToolCall |
| AgentRuntime/PiExecutor | 一次 Run 的实际生成、全部 Pi Message 按 Entry 持久化、SSE、取消、State 结算 | 将旧 ToolResult 混进新模型历史 |
| StateReader / Script Runtime | 只读状态访问、隔离的 JavaScript 表达式求值 | 直接数据库访问、未授权持久化写入 |
| ContentActivation | 常驻、关键词、排除词和 when 的统一加载判断 | Prompt 组装、模板渲染 |
| TextRenderer / TextTransform | 隔离的 EJS 渲染；按场景执行受控文本转换 | 内容激活、直接持久化状态 |

所有公开领域接口及用途见 [领域 API](../design/domain-interfaces.md)；Session 的完整分页契约见 [Session](../design/session.md)。

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
      lorebook.ts
      node-builders/          # 七个系统节点 + 自定义文本节点
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
  world/
  text/
packages/shared/src/
  api/
  events/
~~~

不保留 WorldInstanceContext 或另外一套 AgentContext/模板执行器。Prompt、预设与状态栏的共享文本规则归 core/text。

## 4. 运行与读取两层结构

~~~mermaid
flowchart TD
  UI[H5] --> Runtime[AgentRuntime: 生成逻辑 run_id]
  Runtime --> Sess[SessionService: 会话与世界线业务]
  Runtime --> Repo[EntryRepository: 原始消息持久化]
  Sess --> DB[(SQLite 六张表; entries.run_id)]
  Repo --> DB
  Runtime --> Ctx[AgentContext]
  Ctx --> Repo
  Ctx --> Raw[沿 tip.parent_id 加载完整 Raw Ancestors]
  Raw --> Projection[NarrativeProjection: user/assistant 叙事]
  Ctx --> State[独立完整 State]
  Ctx --> Config[WorldCard 策略 + Preset 预算 + Provider 上限]
  Projection --> Match[ContentActivation：角色 / 世界书 / 状态根]
  State --> Match
  Config --> Match
  Match --> Nodes[按序执行普通 Prompt 脚本，worldState 本体占位]
  Nodes --> LateState[只读最新工作状态，延迟填回 worldState]
  LateState --> Frozen[冻结 Prompt 节点 + 历史消息槽位]
  Frozen --> Budget[组装候选 Context + 完整 Token 判断]
  Projection --> Budget
  Config --> Budget
  Budget --> Compress[按需仅裁剪或摘要历史 messages，保留冻结 Prompt]
  Compress --> Messages[最终 ModelMessage + Token 复查]
  Messages --> Pi[Pi Executor]
  Pi --> EntryWrites[Message / ToolResult / 技术 Entry 全量入库]
  EntryWrites --> Sess
  Pi --> StateEngine[StateEngine 校验 reason 和完整状态]
  StateEngine --> Sess
  Pi --> UI
~~~

**三份视图不可混淆**：

- Raw History：当前世界线完整 Pi Entry 父链，可用于 State、分页、世界线、诊断。
- Narrative Context：只将 user/assistant 叙事放入模型历史，并应用窗口/摘要与 Token 预算；用户可见聊天投影相同但 UI **不按 Token 裁剪历史**。
- Current State：当前原始父链最新完整有效状态，按世界卡最新 Schema 校验/重置；不受 Context 策略影响。

### 一次 Run 的严格时序

1. 取得 Session 的 world_id/preset_id/user_character_id/tip_entry_id，加载最新世界卡、预设、Provider Model；取原 tip 的完整真实父链与 State。此时**尚未写本轮 User**。
2. 计算有效预算 `B = min(Preset.max_context_tokens（若设置）, Model.contextWindow) - max_output_tokens - TOKEN_ESTIMATION_GUARD`；内部 Guard 首期固定 1024 Token，**用户只设置 max_context_tokens / max_output_tokens**。窗口由 WorldCard 选择：默认 window、可选 summary，不支持 none。
3. Window 先限制最近 N 条候选叙事，再根据候选消息 + 当前 User + 完整 State **仅一次**匹配 lorebook/角色/状态、按序执行 NodeBuilder 和模板脚本，最后读取工作状态生成 worldState 并填回位置，冻结 Prompt。组装候选完整 Context 检查 Token。若超 B，Window 只裁最旧 messages；Summary 在未覆盖消息达到 N 或超 B 时摘要旧 messages、保留 K 条原文。**不重做关键词匹配或构建 Prompt**，只替换历史 messages 并复核最终 Token；仍超限时显式失败，不裁当前 User 或固定 Prompt。
4. 确认本轮最终消息集合并沿用冻结的世界书命中与 NodeBuilder 结果后，若生成摘要则先得到完整摘要请求/回复，**在写入本轮 User 之前**将摘要 compaction Entry 与 User 依次写入父链，两者共用新 run_id；无摘要直接写 User。
5. 调用 Pi；Assistant 可能含 ToolCall，ToolResult 作为独立 Message Entry；Pi 其它技术 Entry 也原样保存。已成型消息全部按真实顺序归属本轮 run_id，SSE delta 本身不作为完成 Entry。
6. StateService 验证带 reason 的 ChangeSet，完成 Assistant 上记录全量 S'。终止工具 `submit_turn` 若只返回 narrative，在保留原始 ToolCall/ToolResult 的基础上新增 `origin=derived_tool_narrative` 的可见 Assistant Entry，防止叙事丢失和重复。
7. 下次 Pi 请求只恢复 NarrativeProjection 后的历史，旧 ToolCall/ToolResult 只存在 Raw History；状态从全量父链独立恢复。

## 5. Run 分页与分叉

- `entries.run_id NOT NULL`，一个玩家逻辑互动对应多条 Entry；初始化 Opening 也是独立 Run。重生成 Assistant 复用历史 User 的逻辑 run_id，重选 User 产生新 run_id。
- `getRunPage` **先沿选中 tip 的 parent_id 得到祖先集合**，再按 run_id 分组、以每组最小 seq 作为游标锚点；limit 是 Run 数，结果含选中 Run 的**全部** Entry。**不能只按 run_id 扫全 Session**，否则可能混入其他分支。
- `getChatPage` 对同一批 Run 再做叙事投影，ToolCall、ToolResult、Summary 不直接显示；世界线 Root/Fork-only 折叠技术记录。
- 切换分支只改 Session.tip_entry_id，重置分页 cursor；旧分支数据、全量状态与摘要不删除。

## 6. MVP 范围和约束

SQLite **六表**为唯一权威存储：`worlds / presets / provider_credentials / tags / sessions / entries`。不建 runs、messages、run_tool_calls、world_tags、context_checkpoints 等表；`entries.role` 是叙事角色索引（仅 message 非空），`entries.state` 保存单份完整状态数组，`entries.ext_data` 保存扩展元数据；世界卡删除按 FK CASCADE 完整清理其会话 Entries；单 Session 同时最多一个在途模型执行，不提前设计分布式事务矩阵。

WorldCard/Opening/角色/lorebook、Preset/Provider 模型与 API Key、Session/Run 查询/分叉、Current State/Context Preview、Pi SSE 是 MVP API。调试 Raw Entries 时注意 Key 和私人内容脱敏。

**Pi 接口实测**：OpenAI-compatible 模型可能将后置 system 重排，`session.prompt(text)` 可能多追加一个 User。正式实现必须核对实际 HTTP role/order，当前 User 只能出现一次；不能把示意方法名误认成 SDK 原生接口。

相关：[Session](../design/session.md)、[Context Strategy](../design/context-strategy.md)、[AgentContext](../design/agent-context.md)、[Preset](../design/preset.md)、[State](../design/state.md)、[Storage](storage.md)、[Implementation Plan](implementation-plan.md)。