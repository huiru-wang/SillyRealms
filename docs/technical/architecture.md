# 技术架构：领域服务、双 Context 与 Pi 执行

> 2026-11-03 目标技术设计，尚未实现。目标技术栈：**React + Vite + TypeScript**（移动端优先 H5）、**Hono + TypeScript**（本地服务）、**SQLite**（唯一权威存储），Pi Agent 作为可替换模型执行底座。产品领域见 [PRODUCT](../PRODUCT.md)；职责与详细接口依 [Preset](../design/preset.md)、[Provider](../design/provider.md)、[AgentContext](../design/agent-context.md)、[WorldInstanceContext](../design/world-instance-context.md)、[Session](../design/session.md) 和 [State](../design/state.md)。

## 1. 核心原则

- **Run 是唯一会话树节点**，Message 是 Run 内内容；History/分页/世界线压缩统一按 Run；已保存的 Run/Message/State 在 SQLite 中，Pi 运行时对象不是第二份历史。
- **Preset 提供配置**：仅存有序 Nodes、自定义文本、role、预算和扫描深度，提供只读 Snapshot；不拼 Prompt、不绑定 Provider。
- **WorldInstanceContext 提供世界运行资料**：本局世界快照、玩家身份、宏、状态定义、WorldBook 钩子预索引和可丢弃的压缩 Run 拓扑缓存；不保存跨分支“当前全局值”。
- **AgentContext 提供一次构建**：先加载冻结的父 Run 状态，再逐个执行 Preset NodeBuilder 的 before/body/after、通用模板，主流程统一 Token 预算和裁剪，返回完整有序的 `ModelMessage[]`；不依赖 Provider 连接。
- **Provider/Pi 负责执行**：只选预置 Provider/模型和 API Key；各 Provider 独立封装差异。Pi 只运行受控模型请求，默认 Coding Tools/自动技能禁用；自定义 Provider/Endpoint MVP 不开放。
- **StateEngine 负责独立结算**：统一强类型 Schema、ChangeSet、快照/修订；不在 Context/Provider 内写状态业务校验。

## 2. 模块和依赖方向

~~~mermaid
flowchart TD
  UI[React H5] --> API[Hono API]
  API --> SessionService
  API --> PresetService
  API --> ProviderService
  SessionService --> WIC[WorldInstanceContextService]
  SessionService --> AC[AgentContextBuilder]
  PresetService -->|PresetSnapshot| AC
  WIC -->|WorldInstanceContextView| AC
  SessionService -->|Run history and State| AC
  AC -->|ModelMessage array + StateOutputContract| Executor[PiAgentExecutor]
  SessionService -->|ModelSelection| ProviderService
  ProviderService -->|Built-in Adapter + Credential| Executor
  Executor -->|Narrative + Changes| StateEngine
  StateEngine -->|Validated State Result| SessionService
  SessionService --> SQLite[(SQLite)]
  PresetService --> SQLite
  WIC --> SQLite
  ProviderService --> Credentials[(Secure Credential Store)]
~~~

依赖必须单向：`NodeBuilder` 不 import Provider/SQLite；`ProviderAdapter` 不 import WorldBook/Preset；`WorldInstanceContext` 不构建最终 Prompt；`SessionService` 作为应用层编排者，不包含文本模板实现。每个领域提供尽可能窄的**只读读取口**与负责修改的命令口，避免共享可变大对象。

## 3. 一次 Run 的完整执行链

~~~mermaid
sequenceDiagram
 participant UI as H5
 participant S as SessionService
 participant DB as SQLite
 participant W as WorldInstanceContext
 participant P as PresetService
 participant C as AgentContext
 participant M as Provider/Pi
 participant E as StateEngine
 UI->>S: 发送文本 + expectedLeafRunId + requestId
 S->>DB: 新建 awaiting_ai Run + User Message + 继承状态
 S->>W: open/refresh 本局世界快照与索引
 S->>P: getPresetSnapshot(presetId)
 S->>DB: 读取冻结父 Run 状态与祖先 Runs
 S->>C: build(Preset, WorldView, Run, ParentState, BudgetLimits)
 C->>C: StateLoader -> Hooks -> NodeBuilders -> Render -> Budget
 C-->>S: ModelMessage[] + StateOutputContract + diagnostics
 S->>M: execute(Messages, ModelSelection, StateOutputContract)
 M-->>UI: 文本 delta / 诊断（暂态）
 M-->>S: narrative + change payload / usage
 S->>E: 校验 ChangeSet + 全快照
 S->>DB: 乐观并发检查 + Assistant Message + Run 结算事务
 S-->>UI: completed / error
~~~

**调用开始时冻结**：runId、parentRunId、PresetSnapshot revision、world_snapshot_revision、context_options_revision、状态 Schema hash/父状态 revision、ModelSelection 与 TokenBudget 限额；调用中不能随其他操作改写组成当前请求的材料。请求失败/取消只留下已经保存的 User Run；状态失败须显式可诊断，不当作无变化。

## 4. Pi Adapter 与 Provider 设计边界

Pi SDK 已提供内存 Session 和流式执行能力，现有本地 Mock 可用于基础接入验证；但 **`session.prompt(userText)` 不自动意味着能传入任意排序的全量 ModelMessages**。Provider/Pi 适配需要先用固定 Pi SDK 版本验证受控历史恢复、完整 Message 数组角色顺序、流式、取消、实际 model/Key 映射和一次生成状态 Tool 调用。若无法在 Pi 当前公共 API 中无损呈现构建好的 Messages，须记录阻塞并评估它所支持的更底层模型接口；**不得悄悄重排角色或扁平化全部消息**。

每个内置 Provider 模块声明模型能力、凭据来源、Pi 模型映射、stream/tool 差异和 Provider 特殊错误转换；对 Session 只暴露统一执行契约与 Event Stream。可用的 `submit_turn` Tool Call 必须经真实模型验证长文本流式与复杂 Schema，不支持时采用带 `<StateUpdate>` 的内联回退。状态更新语义归 StateEngine，不在每个 Provider 重写校验逻辑。

## 5. 运行时 Context 与缓存

进入世界实例时 `WorldInstanceContextService.open(sessionId)` 重建索引（首期最容易保证正确），会话期间缓存可按 revision 失效并重新加载。角色宏由选中角色 Session 快照确定。WorldBook/状态定义的加载前索引属于 WIC；**真正按本轮文本激活什么条目和状态**属于 AgentContext。进入世界实例不重做 Opening/状态初始化，切换活动叶子只改变运行状态读取路径。

全局世界线从 Runs 轻量父链派生 Root/Fork-only 压缩图，连线按折叠 Run 数量计数，并通过终止边 `terminal_leaf_run_id` 进入路线。WorldInstanceContext 可按 `(run_tree_revision, run_content_revision)` 缓存图，消息编辑/Run 结算更新内容修订以失效摘要/状态依赖，静态世界索引不受 Run 追加影响。缓存不是 SQLite 之外的第二套权威历史。

## 6. API 和 MVP UI

H5 路由/页面聚焦世界卡库、世界实例列表、Chat、Root/Fork 压缩世界线、Preset 编辑、预置 Provider 模型/密钥设置和独立状态面板。聊天历史只向上按 Run 分页，默认 30 Run，Run 内可呈现 1～2 条可见消息；全局世界线仅展示 Root/Fork 和带隐藏 Run 计数的线，允许点击终止线进入真实叶子。

接口边界：
- Preset：`GET/POST/PUT/DELETE /presets`、导入导出，更新基于 revision；
- Provider：`GET /providers` / `GET /providers/:id/models`、设置/验证/删除 API Key，绝不回显密钥；
- Session：`GET /sessions/:id/runs`、`POST /sessions/:id/runs`、`POST /sessions/:id/forks`、`GET /sessions/:id/worldlines`、`PUT /sessions/:id/active-leaf`；
- Agent Context Preview：`POST /sessions/:id/agent-context/preview`（只读，不调用模型），返回规范化消息/来源/预算/错误，剔除私人密钥；
- Model invocation：一次 Run 的 SSE，事件和错误由 Provider 适配规范化，完成后由 Session 持久化。

MVP 不提供自定义 Provider/URL、任意聊天中间窗口、跨设备会话阅读锚点、Run/Message 删除、任意世界卡 JS 脚本。世界卡导入的脚本/HTML 可归档但**不默认执行**。

## 7. 实施阶段与验证门槛

1. **基础领域模型**：固定 PresetNode/ProviderDefinition/Run/Message/WorldInstanceContextView/ModelMessage/StateOutputContract 的 TypeScript 契约和 import 层次，编译无环。
2. **Preset + Provider**：Preset 增删改导入导出、预置模型目录、密钥保存/验证、固定 Pi 版本受控执行 PoC，模型无损多 role/order 验证。
3. **WorldInstanceContext + AgentContext**：索引、版本失效、状态先加载、节点注册表、before/body/after、统一文本管道、主流程 Token 预算/Run 整组裁剪。
4. **Session/Storage**：SQLite Run/Message 事务和分页、Root/Fork-only 世界线、按 Run 的状态快照与分支隔离、前端 Run 消息组。
5. **整体验证**：世界卡资料变化、用户身份/宏、条件世界书、不同预设顺序、Token 预算、Provider 状态工具、1000+ Runs、失败/重试/分叉/历史编辑/应用重启。

**尚未验证**：生产 SQLite 接入、真正 Provider 连接和 Tokenizer 计量、长篇 Tool Call 流式、Pi SDK 是否能按原始 Messages 保序注入。不能把本文件内容当成已完成的代码或服务能力。

更多任务与里程碑见工作区 `plan/sillyrealms-domain-refactor-tasks.md`。
