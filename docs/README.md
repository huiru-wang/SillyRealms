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
| [session.md](design/session.md) | Run/Entry 分离，run_id 游标分页、parent_id 世界线分叉、三类 Pi Entry |
| [context-strategy.md](design/context-strategy.md) | window/summary 与完整 Prompt Token 预算、触发/缩窗/摘要边界 |
| [agent-context.md](design/agent-context.md) | 唯一 AgentContext：历史投影、全量状态、条目筛选、七 NodeBuilder → ModelMessage[] |
| [script-runtime.md](design/script-runtime.md) | 三作用域状态 API、JavaScript/EJS 与临时变量 |
| [content-activation.md](design/content-activation.md) | 角色、世界书条目与状态根的统一加载判断 |
| [text-rendering.md](design/text-rendering.md) | 文本模板渲染与按场景独立配置的受控转换 |
| [state.md](design/state.md) | 类型 Schema、状态根加载、ChangeSet(reason 必填)、完整状态和不兼容处理 |
| [architecture.md](technical/architecture.md) | Monorepo 分层、Pi 执行/SSE 和消息全量持久化 |
| [storage.md](technical/storage.md) | 六表 SQLite DDL、tags type 内排序、Entry payload、世界线 |
| [implementation-plan.md](technical/implementation-plan.md) | 实现阶段与 PoC/验收清单 |

## 数据格式

[数据格式说明](data-formats/README.md)区分配置导出、数据库列和运行状态。JSON 文件是目标结构的参考数据，并非声称已经由 SR 实际导出。

- [world-card.json](data-formats/world-card.json)：世界卡原生数据示例，支持 context；没有 Opening 的 player_characters。
- [default-preset.json](data-formats/default-preset.json)：预设导出格式，含 model/state_update_mode/summary_prompt。
- [entry-record.json](data-formats/entry-record.json)：SQLite Entry 行与 JSON 文本列的参考结构。
- [message-state.json](data-formats/message-state.json)：Entry 消息级状态数组的参考结构。

## 必须遵守的统一约束

1. **Raw Entries 全量持久化**：包含 user、assistant（其中的 toolCall）、toolResult 和技术摘要，`run_id` 作为 Run 分页单位，不能用过滤后的聊天文本替换数据库记录。
2. **叙事投影一致**：用户聊天、下一轮模型历史和关键词扫描只含 user/assistant 的叙事文本；过滤旧 toolCall/toolResult/思维/内联状态更新。
3. **State 独立**：Global 归属世界卡，Session 归属会话，Message 沿真实 parent_id 父链读取；不因窗口/摘要而丢失。世界卡最新 Schema 不兼容时提示冲突并保留旧数据；迁移或重建前须明确选择并备份。
4. **world_id/preset_id 关联最新数据**：Session 不保存 World Snapshot、Opening ID、模型选择或 Options。模型与摘要 Prompt 属 Preset，上下文策略属 WorldCard。
5. **加载条件**：只用 always/on_mention，when 与关键词是 AND；角色也支持 order。没有 manual 与 Preset 独立扫描深度。
6. **首期 Monorepo 仅 Web/Server**：Android/Desktop 后续进入，packages/core/shared 只在有实际复用需求时落地。
