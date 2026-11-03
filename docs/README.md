# SillyRealms · 文档索引

> 2026-11-03 第二版单 Context + 六表方案，**仍是设计阶段**。核心约束：本地单人、世界卡驱动、真实 Entry 分叉、可选强类型状态和 Pi 模型流式执行。

## 推荐阅读顺序

[产品总纲](PRODUCT.md) → [AgentContext](design/agent-context.md) → [Session/Entry](design/session.md) → [Storage](technical/storage.md) → [技术架构](technical/architecture.md) → [实施计划](technical/implementation-plan.md)。

## 领域设计

| 文档 | 说明 |
| --- | --- |
| [world-card.md](design/world-card.md) | 世界卡、Opening、角色、WorldBook、状态声明与加载条件 |
| [preset.md](design/preset.md) | 系统/自定义节点、role、顺序、导入导出；系统 NodeBuilder 在 AgentContext 中 |
| [provider.md](design/provider.md) | ProviderService 查询 Pi 内置模型、用户 Key 与凭据状态 |
| [agent-context.md](design/agent-context.md) | **唯一 Context**：分支历史/最新全量状态、世界书/状态筛选、索引、节点构建 → Messages |
| [text-rendering.md](design/text-rendering.md) | **共享文本能力**：变量、条件、状态引用、受控转换；Agent/世界卡/状态栏复用 |
| [session.md](design/session.md) | Session 与 Entry 父树、内嵌 `runs[]`、Summary、分叉/重试/切叶子/世界线 |
| [state.md](design/state.md) | 强类型状态 Schema、Module 加载、ChangeSet、完整快照 |
| [architecture.md](technical/architecture.md) | AgentRuntime/Pi/SSE 和业务 Domain 分层 |
| [storage.md](technical/storage.md) | **仅六张业务表**、内嵌 Run JSON、通用 tags、SQLite 最简写入 |
| [implementation-plan.md](technical/implementation-plan.md) | 真实 SDK PoC、Domain/Agent/UI 实施与验收 |

## 例子与历史研究

- [world-card.json](examples/world-card.json)：世界、角色、WorldBook/状态示例。
- [default-preset.json](examples/default-preset.json)：有序系统/自定义节点、预算及关键词扫描深度。
- [Pi SDK 实验报告](../experiments/pi-sdk-feasibility/REPORT.md)：2026-11-01 当时版本 mock 结果，不证明真实 Provider 的所有消息角色顺序。
- [state-management-module.md](state-management-module.md)：**废弃草案**，不作为当前协议。

## 统一设计约定

1. 没有 `WorldInstanceContext`。AgentContext 自行加载会话、历史、状态与预设，并按 NodeBuilder 顺序产出 ModelMessage[]；最终渲染交由独立 TextRenderer。
2. Session 关联世界快照和角色；Entry 是一整个回合，`parent_entry_id` 提供分叉；`runs_json` 保存生成/工具/状态尝试。只保留六张业务表，不设独立 Run/Message/工具/设置/标签关联表。
3. 世界书/状态根的 `when` 使用真实分支**完整**状态；Summary 截断和近 N 消息只影响 Prompt 历史。
4. 保留 ProviderService，但 Pi 负责内置模型目录和各供应商实际调用；API Key 不出现在 WorldCard/Preset/Session 导出和日志。
5. 本地单人简化锁与并发，同时保证两行写入基本原子性；未来能力不得在 PoC 前宣称已实现。
