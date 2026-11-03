# SillyRealms · 文档索引

> 2026-11-03 精简架构方案，**设计阶段，尚未实现**。原先的双 Context 缓存/Provider Adapter 方案已收敛为一条单轮 Agent 链路；旧实验报告仍只代表对应 Pi SDK 版本的验证事实。

阅读顺序：[产品总纲](PRODUCT.md) → 各领域设计 → [技术架构](technical/architecture.md) → [持久化](technical/storage.md) → [实施计划](technical/implementation-plan.md)。

## 领域设计 · `design/`

| 文档 | 职责 |
| --- | --- |
| [world-card.md](design/world-card.md) | 世界卡、角色、Opening、单 WorldBook、强类型状态定义和导入导出 |
| [preset.md](design/preset.md) | 预设节点配置、顺序、role、预算、导入导出与读取；不构建 Prompt |
| [provider.md](design/provider.md) | **ProviderService**：查询 Pi 内置支持模型、用户 API Key 安全配置与校验、ModelSelection；不为每家重写适配器 |
| [world-instance-context.md](design/world-instance-context.md) | **WorldInstanceContext**：每次输入从 Session 读取的普通运行时 metadata；没有缓存服务/生命周期 |
| [agent-context.md](design/agent-context.md) | **AgentContext**：世界书、模板、预设编排与 Run 历史 → `ModelMessage[]` |
| [session.md](design/session.md) | Session、Run 父树、Run 内 Messages、分叉/重试、Run 分页、Root/Fork-only 世界线 |
| [state.md](design/state.md) | 强类型状态树、受限 ChangeSet、Run 全状态快照、一次状态范围选择和校验 |

## 技术设计 · `technical/`

| 文档 | 主题 |
| --- | --- |
| [architecture.md](technical/architecture.md) | `createSession` 与 `runAgent` 单线流程、Domain / Agent Runtime 目录、Pi/SSE 与持久化 |
| [storage.md](technical/storage.md) | SQLite 表和短事务、Run/Message/全状态快照、分页与并发约束 |
| [implementation-plan.md](technical/implementation-plan.md) | PoC、分阶段实施、验收和回滚；工作区 `plan/sillyrealms-domain-refactor-tasks.md` 与其同步 |

## 示例与历史资料

- [world-card.json](examples/world-card.json)：世界卡、Opening、WorldBook、状态数据示例。
- [default-preset.json](examples/default-preset.json)：七系统节点和自定义文本、顺序与预算配置示例。
- [Pi SDK 可行性实验报告](../experiments/pi-sdk-feasibility/REPORT.md)：2026-11-01 的本地 mock 实测，包含后置 system 不能无损保持位置的限制。
- [state-management-module.md](state-management-module.md)：**历史废弃草案**，不是当前协议。

## 统一约定

1. **Session/Run/Message/State 的 SQLite 记录是唯一事实来源**。Session 保存世界卡快照、玩家身份、Preset ID 与模型选择；当前模型历史仅来自所选父 Run 祖先链。
2. Provider Domain 保留 Service 提供模型和 API Key 配置；模型目录、调用协议、认证解析尽量复用 Pi；AgentContext 不读密钥，Pi 不替代业务 Session。
3. WorldInstanceContext 每轮直接加载，不是常驻实例或缓存协调器；AgentContext 只构建 Messages。世界线拓扑属于 Session，不属于 Context。
4. State Domain 计算同一轮只读状态范围，供 Prompt 和可选更新工具共用；工具不在生成中直接提交世界状态。
5. 未经验证的 SDK 消息 role/order、实际 Provider Tool/流式表现不得称为已实现；真实世界卡脚本/HTML 可以保留来源，但 MVP 不默认执行。
6. 修改协议时同步检查相关设计/架构/存储/示例，不把历史研究方案或旧 Entry 父链语义混入当前实现。
