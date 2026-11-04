# SillyRealms · 设计文档索引

> 2026-11-04 目标规范，尚未实现。**Monorepo + 6 张业务表 + Entry.run_id 按 Run 分页 + 原始工具消息全量持久化 + 叙事 Context/State 分离**。

建议阅读顺序：[产品总纲](PRODUCT.md) → [Session/Entry](design/session.md) → [Context Strategy](design/context-strategy.md) → [AgentContext](design/agent-context.md) → [Storage](technical/storage.md) → [架构](technical/architecture.md)。

## 核心文档

| 文档 | 职责 |
| --- | --- |
| [world-card.md](design/world-card.md) | 世界卡唯一版本、Opening/角色、lorebook/状态加载、默认 window / 可选 summary |
| [preset.md](design/preset.md) | Preset 关联 Pi 模型、参数、状态模式、摘要 Prompt 和有序节点 |
| [provider.md](design/provider.md) | ProviderService 内置模型列表、API Key 安全管理 |
| [domain-interfaces.md](design/domain-interfaces.md) | World/Preset/Provider/Tag/Session/State/Agent 每个领域接口的单句职责 |
| [session.md](design/session.md) | Run/Entry 分离，run_id 游标分页、parent_id 世界线分叉、四类 Pi Entry |
| [context-strategy.md](design/context-strategy.md) | window/summary 与完整 Prompt Token 预算、触发/缩窗/摘要边界 |
| [agent-context.md](design/agent-context.md) | 唯一 AgentContext：历史投影、全量状态、条目筛选、七 NodeBuilder → ModelMessage[] |
| [text-rendering.md](design/text-rendering.md) | Web/Server 复用变量、条件、状态引用与受控文本转换；摘要 Prompt 可用 |
| [state.md](design/state.md) | 类型 Schema、状态根加载、ChangeSet(reason 必填)、全量快照和失效重置 |
| [architecture.md](technical/architecture.md) | Monorepo 分层、Pi 执行/SSE 和消息全量持久化 |
| [storage.md](technical/storage.md) | 六表 SQLite DDL、tags type 内排序、Entry payload、世界线 |
| [implementation-plan.md](technical/implementation-plan.md) | 实现阶段与 PoC/验收清单 |

## 示例和历史资料

- [world-card.json](examples/world-card.json)：世界卡原生数据示例，支持 context；没有 Opening 的 player_characters。
- [default-preset.json](examples/default-preset.json)：当前预设格式，含 model/state_update_mode/summary_prompt。
- [Pi SDK 可行性 PoC](../experiments/pi-sdk-feasibility/REPORT.md)：角色顺序和实际 Pi SDK 适配的已有本地实验，不能代替真实 Provider 端到端测试。
- [state-management-module.md](state-management-module.md)：历史讨论草案，**不是当前权威规范**。

## 必须遵守的统一约束

1. **Raw Entries 全量持久化**：包含 user、assistant（其中的 toolCall）、toolResult 和技术摘要，`run_id` 作为 Run 分页单位，不能用过滤后的聊天文本替换数据库记录。
2. **叙事投影一致**：用户聊天、下一轮模型历史和关键词扫描只含 user/assistant 的叙事文本；过滤旧 toolCall/toolResult/思维/内联状态更新。
3. **State 独立**：沿真实 parent_id 父链取最新有效全量状态；不因窗口/摘要而丢失。世界卡最新 Schema 不兼容时允许重置旧状态，旧消息留存。
4. **world_id/preset_id 关联最新数据**：Session 不保存 World Snapshot、Opening ID、模型选择或 Options。模型与摘要 Prompt 属 Preset，上下文策略属 WorldCard。
5. **加载条件**：只用 always/on_mention，when 与关键词是 AND；角色也支持 order。没有 manual 与 Preset 独立扫描深度。
6. **首期 Monorepo 仅 Web/Server**：Android/Desktop 后续进入，packages/core/shared 只在有实际复用需求时落地。
