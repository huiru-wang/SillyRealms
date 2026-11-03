# SillyRealms · 文档索引

> 2026-11-03 领域职责重构。当前为**产品/领域/技术方案，尚未实现**；文档目录按职责拆分，旧 `configuration.md` 和 `context.md` 已分别更名/拆分，不再作为权威入口。

阅读顺序：先 [产品总纲](PRODUCT.md) 理解玩家/创作者体验，再进入各领域文档理解数据契约与模块责任，最后阅读 [技术架构](technical/architecture.md)、[持久化](technical/storage.md) 和 [实施规划](technical/implementation-plan.md)。运行时是否已验证以各文档的“尚未实现/PoC”声明为准。

## 领域设计 · `design/`

| 文档 | 唯一职责 |
| --- | --- |
| [world-card.md](design/world-card.md) | 世界卡内容与发布、角色与 Opening、单 WorldBook、强类型状态定义入口和钩子元数据 |
| [preset.md](design/preset.md) | **Preset 领域**：预设导入导出、系统/自定义 Prompt 节点、role、顺序、预算策略、表结构和不可变读取接口；**不构建内容** |
| [provider.md](design/provider.md) | **Provider 领域**：预置供应商/模型、API Key、独立适配、Pi 执行和差异收敛；**不构建 Prompt** |
| [agent-context.md](design/agent-context.md) | **AgentContext**：单轮状态预加载、节点钩子、纯文本变换、统一 Token 预算，最终输出完整有序 Messages |
| [world-instance-context.md](design/world-instance-context.md) | **WorldInstanceContext**：世界实例身份/宏、WorldBook 钩子索引、Schema 和拓扑缓存、失效/重建 |
| [session.md](design/session.md) | **Run 为树节点**、Run 内 Messages、分页/分叉/重试、仅 Root/Fork 可见的压缩世界线 |
| [state.md](design/state.md) | 强类型状态树、Zod/JSON Schema、受限 ChangeSet、按 Run 的全量快照、状态只读引用 |

## 技术设计 · `technical/`

| 文档 | 主题 |
| --- | --- |
| [architecture.md](technical/architecture.md) | React/Hono/SQLite 架构、五领域依赖方向、Pi Agent 适配与一次 Run 调用流程 |
| [storage.md](technical/storage.md) | `sessions/runs/messages/presets/provider_credentials` 的存储契约、事务、Run 分页与缓存版本 |
| [implementation-plan.md](technical/implementation-plan.md) | 实施分阶段顺序、需做的真实 PoC、跨模块集成验收与风险 |

## 示例 · `examples/`

- [world-card.json](examples/world-card.json)：原生 WorldCard 示例，独立角色/开局/WorldBook/强类型状态树；`spec_version` 与内容版本不同。
- [default-preset.json](examples/default-preset.json)：系统默认 Preset 的完整有序节点数组、可编辑主/后置 Prompt、预算策略与默认 `scan_depth_runs`。

## 文档维护原则

1. **PRODUCT** 负责目标与体验，**design** 负责领域模型与对外契约，**technical** 负责架构/存储/验证门槛，示例需与所有数据规范一致。
2. Preset 不处理正文构建；AgentContext 不依赖 Provider；WorldInstanceContext 不持久化另一份世界状态；Session/Run 不提供具体模型 Prompt 内部实现。
3. 修改 Run/Message/WorldInstanceContext 时同步审核强类型状态、SQLite、API、示例和世界线缓存；绝不混用旧 Entry 树的父链/分页/隐藏消息计数语义。
4. 新功能必须明确“已实现、尚待验证或未来规划”，不得将未经 PoC 的 Pi 保序 Messages/复杂 Tool Call 宣称可用。
5. 导入来源卡可保留 HTML、regex_scripts、其他元数据，但保留不等于执行；用户密钥和私人聊天原文不得写入公开示例或日志。

**历史方案**：[state-management-module.md](state-management-module.md) 是废弃草案，只供研究，不能作为当前协议使用。工作区 `plan/` 下的历史研究草案不是最新领域设计的双重权威。
