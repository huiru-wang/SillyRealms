# SillyRealms · 产品总纲

> 2026-11-03 产品与精简架构目标，**尚未实现**。世界卡驱动、本地优先、以持续叙事为核心；领域协议见各设计文档。

## 1. 定位与主旅程

SillyRealms 是世界卡驱动的 LLM 交互客户端。创作者设计世界、角色、世界书、开局和可选强类型状态；玩家在允许角色中选择身份，沿同一 Session 下不同的 Run 世界线推进故事。不强迫所有剧情转成数值模拟，不建立云内容平台。

**用户旅程**：世界卡库 → 选择世界卡、Opening、可扮演角色、Preset、模型 → 创建 Session → Chat → Run 历史/压缩世界线 → 继续或新分叉。

## 2. 产品对象与边界

| 对象 | 用户能感知的能力与技术职责 |
| --- | --- |
| WorldCard | 角色、Opening、单 WorldBook、强类型状态定义、资源、发布与导入导出 |
| Preset | 七个固定系统节点 + 自定义文本、名称、role、启用/顺序/预算、复制与导入导出；不绑定模型 |
| **Provider** | **保留 ProviderService**：查询 Pi 内置支持的供应商和模型、展示能力/配置状态、用户输入/删除/验证 API Key、选择默认/Session 模型；不自行编写每 Provider Adapter |
| Session | 世界实例的持久化记录：世界卡快照、选中身份快照、Opening、Preset ID、模型选择、状态定义与活动叶子 |
| WorldInstanceContext | 每次运行按 sessionId 派生的普通 metadata，随本轮执行结束释放；没有实例缓存/生命周期服务 |
| AgentContext | 单次模型调用的 `buildAgentContext()`：世界书、状态只读引用、预设节点编排、模板与完整 Run 历史，产出 `ModelMessage[]` |
| AgentRuntime | 唯一调用入口 `runAgent()`；Pi 模型执行、SSE 转发、最终结果持久化的业务编排 |
| Run | 每次完整互动回合，承载父子世界线关系、状态快照和 Run 内消息 |
| Message | Run 内玩家可见 User/Assistant 文本；Opening Root 只有初始 Assistant |
| State | 可选强类型状态树、受限 ChangeSet、同一 Run 的完整状态快照；模型工具生成的是待校验候选 |
| 世界线 | 仅显示真实 Root/Fork，其他 Run（含 Leaf）折叠到线段，线段统计隐藏 Run 数并可进入终止真实叶子 |

## 3. 创作者与玩家体验

- **世界卡编辑**：世界设定、角色可扮演许可、Opening、WorldBook 加载/前后锚点、状态树、资源；导入原始脚本/HTML 可保存但不默认执行。
- **状态管理**：可视化创建对象、数字、字符串、枚举、字典、数组、JSON；作者配置初值与描述，引擎校验而不是让作者写 JSON Patch/Zod。
- **Preset 管理**：节点拖拽、修改系统/自定义文本、role、启用和预算；显示真实编排 Preview，不以作者编辑器顺序取代模型协议能力验证。
- **Provider 设置**：只允许产品支持的 Pi 内置模型，用户配置 API Key；区分「已有密钥」和「真实连接已验证」，不允许自定义 Base URL/Provider。
- **Context 预览**（高级功能）：展示 `buildAgentContext` 的消息顺序/role、世界书命中及基础历史裁剪情况，不调模型、不暴露 Key。

Session 创建前必须校验可用 Preset、世界卡、Opening、可扮演角色和支持模型/本地凭据；原子创建 Session + Opening Root Run + 初始消息/状态，不允许半成品。每次 Prompt 通过 `sessionId` 加载本轮 metadata，创建/复用 awaiting_ai Run 存 User，构建 Messages，Pi 执行并 SSE，成功后在同一 Run 保存 Assistant 和完整状态快照。失败/取消保留 User Run 重试；不直接把 SSE delta 当成已提交回复。

Chat 只展示活动叶子的一条真实父链，默认最近约 30 **Run** 分页，每 Run 内最多一组可见 User/Assistant；从历史旧 Run 作不同选择时创建它的**兄弟 Run**，直接子分支最多三个。世界线只画 Root/Fork，线段包含真实隐藏数与叶子入口；历史编辑引起的因果/状态失效不会被无声覆盖。

## 4. 技术边界与 MVP

React/Vite/TypeScript H5 + Hono/TypeScript 本地 Server + SQLite；Pi Agent/Pi AI 为模型执行底座。**主链路：Session → WorldInstanceContext metadata → AgentContext Messages → Pi Agent/SSE → Session/State SQLite**。Domain（World/Preset/Provider/Session/State）与 Agent 运行时分离，但不额外构建可失效的常驻 Context 服务。

MVP：世界卡与强类型状态、Preset 编辑/导入导出、ProviderService 模型查询与 API Key、Session 创建/Opening、Run 聊天分页/重试/分叉、压缩世界线、可选状态更新和独立状态面板，以及可验证的 Pi 流式执行。**全部是目标，不代表已经有生产实现**。

延期：用户自定义 Provider/URL、OAuth 订阅登录、任意脚本与完整 SillyTavern 插件兼容、图片/TTS、长期记忆压缩、云同步、完整世界线大画布、复杂 Context 缓存或多级 Token Budget 框架。

## 5. 关联文档

[世界卡](design/world-card.md)、[Preset](design/preset.md)、[Provider](design/provider.md)、[WorldInstanceContext](design/world-instance-context.md)、[AgentContext](design/agent-context.md)、[Session/Run](design/session.md)、[State](design/state.md)、[技术架构](technical/architecture.md)、[存储](technical/storage.md)、[实施计划](technical/implementation-plan.md)。
