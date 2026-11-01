# SillyRealms · 文档索引

> 文档重组日期：2026-11-01。当前仍在产品与技术设计阶段；**设计不表示已实现**。

本目录按 **产品总纲 → 领域设计 → 技术实现 → 示例** 组织。同一规则只在其所属文档定义一次，其余文档引用，不复制并维护第二份。

## 阅读顺序

1. **[PRODUCT.md](PRODUCT.md)**：先理解产品定位、核心对象、产品边界和交付阶段。
2. **领域设计**：按问题进入对应领域，回答「用户看到什么、规则是什么」。
3. **技术实现**：在领域约束稳定后阅读架构与存储，回答「如何实现和验证」。
4. **示例**：仅用于说明字段结构，不作为隐含规范或代码运行状态。

## 领域设计 · `design/`

| 文档 | 唯一负责的领域 |
| --- | --- |
| [world-card.md](design/world-card.md) | 世界卡内容结构、角色/场景/世界书/开局、发布版本与实例同步 |
| [session.md](design/session.md) | 世界实例进入与恢复、聊天阅读、全局世界线、任意消息跳转、上下滚动、分叉切换与消息操作 |
| [context.md](design/context.md) | Prompt 构建、世界书触发、宏、注入、预算、分支历史与摘要/记忆可见性 |
| [configuration.md](design/configuration.md) | 预设、Provider、模型连接、配置生效与用户侧凭据边界 |

## 技术设计 · `technical/`

| 文档 | 唯一负责的技术主题 |
| --- | --- |
| [architecture.md](technical/architecture.md) | 本地 H5/Hono 结构、Pi Agent 适配、生成执行流程、接口运行与验证边界 |
| [storage.md](technical/storage.md) | SQLite 表、索引、事务、历史游标、接口草案、备份与迁移 |

## 示例 · `examples/`

- [world-card.json](examples/world-card.json)：世界卡结构示例。`spec_version` 是数据格式版本，`data.version` 是两段内容发布版本。

## 文档维护规则

- **PRODUCT** 只定义目标、范围、核心体验与阶段，不写 SQL、数据库字段或 SDK 细节。
- **design** 按稳定领域划分，不因一次讨论或一个新功能增建孤立的 `*-plan.md` / `*-design.md`；新规则写回权威领域文档。
- **technical** 只描述实现和需验证的约束；产品语义不在技术文档重复作第二份定义。
- 对已确定、待验证、未来规划的内容明确标识；不要把技术假设或草案当作现有功能。
- 示例内容可以变化，不应包含真实 API Key、私人聊天日志或其他敏感数据；修改领域规则时同步校验技术设计及示例。
- 被替代的旧方案不继续与权威文档并存。若未来有重大架构决策需要保存决策过程，再单独引入 ADR；当前不设多层 RFC/计划文档体系。

## 本轮归并关系

原 `product-vision.md` 归并至 `PRODUCT.md`；`world-card-design.md`、`session-branching-design.md`、`prompt-construction-design.md` 分别归并至对应 `design/` 领域文档；`local-runtime-technical-design.md` 拆分至 `technical/architecture.md`、`technical/storage.md`，其中预设与模型连接的领域语义独立至 `design/configuration.md`；旧 `READE.md` 替换为本索引。原始例子迁至 `examples/`。
