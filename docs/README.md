# SillyRealms · 文档索引

> 文档重组日期：2026-11-02。当前仍在产品与技术设计阶段；**设计不表示已实现**。

本目录按 **产品总纲 → 领域设计 → 技术实现 → 示例** 组织。同一规则只在其所属文档定义一次，其余文档引用，不复制并维护第二份。

## 阅读顺序

1. **[PRODUCT.md](PRODUCT.md)**：先理解产品定位、核心对象、产品边界和交付阶段。
2. **领域设计**：按问题进入对应领域，回答「用户看到什么、规则是什么」。
3. **技术实现**：在领域约束稳定后阅读架构与存储，回答「如何实现和验证」。
4. **示例**：仅用于说明字段结构，不作为隐含规范或代码运行状态。

## 领域设计 · `design/`

| 文档 | 唯一负责的领域 |
| --- | --- |
| [world-card.md](design/world-card.md) | 世界卡内容、单个世界书与受限锚点、角色加载、状态字段及 Opening 初值覆盖；世界书不可指定消息角色 |
| [session.md](design/session.md) | MVP 活动叶子入口、只向上祖先分页、压缩世界线拓扑、最简 Entry 生命周期、显式历史分叉及消息操作 |
| [state.md](design/state.md) | MVU 风格 `<UpdateVariable>`、单轮更新、安全解析、完整状态快照与独立状态渲染 |
| [context.md](design/context.md) | 按世界线历史扫描世界书、按七节点编排并合并锚点、宏、顺序预算与构建诊断 |
| [configuration.md](design/configuration.md) | 可编辑且不可删除的基础默认预设、七个固定节点、世界书锚点角色继承、Token 预算及模型连接 |

## 技术设计 · `technical/`

| 文档 | 唯一负责的技术主题 |
| --- | --- |
| [architecture.md](technical/architecture.md) | 本地 H5/Hono 结构、Pi Agent 适配、生成执行流程、接口运行与验证边界 |
| [storage.md](technical/storage.md) | SQLite 表、仅向上祖先游标 CTE、压缩世界线拓扑 API、叶子切换事务、备份与迁移 |

## 示例 · `examples/`

- [world-card.json](examples/world-card.json)：原生世界卡结构示例，单个世界书及无角色字段的相对锚点，含状态定义和不同 Opening 的初值覆盖。`spec_version` 是数据格式版本，`data.version` 是两段内容发布版本。
- [default-preset.json](examples/default-preset.json)：可编辑的基础默认预设七节点、userInput、角色、顺序和 Token 预算示例。

## 文档维护规则

- **PRODUCT** 只定义目标、范围、核心体验与阶段，不写 SQL、数据库字段或 SDK 细节。
- **design** 按稳定领域划分，不因一次讨论或一个新功能增建孤立的 `*-plan.md` / `*-design.md`；新规则写回权威领域文档。
- **technical** 只描述实现和需验证的约束；产品语义不在技术文档重复作第二份定义。
- 对已确定、待验证、未来规划的内容明确标识；不要把技术假设或草案当作现有功能。
- 示例内容可以变化，不应包含真实 API Key、私人聊天日志或其他敏感数据；修改领域规则时同步校验技术设计及示例。
- 被替代的旧方案不继续与权威文档并存。若未来有重大架构决策需要保存决策过程，再单独引入 ADR；当前不设多层 RFC/计划文档体系。

## 本轮归并关系

原 `product-vision.md` 归并至 `PRODUCT.md`；`world-card-design.md`、`session-branching-design.md`、`prompt-construction-design.md` 分别归并至对应 `design/` 领域文档；`local-runtime-technical-design.md` 拆分至 `technical/architecture.md`、`technical/storage.md`，其中预设与模型连接的领域语义独立至 `design/configuration.md`；旧 `READE.md` 替换为本索引。原始例子迁至 `examples/`。
