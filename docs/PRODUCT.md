# SillyRealms · 产品总纲

> 2026-11-03 第二版目标，**尚未实现**。世界卡驱动、本地单人优先、持续叙事与可分叉世界线。

## 1. 产品定位

玩家从世界卡选择 Opening、允许扮演的角色、Preset 和模型创建世界实例，沿不同互动路线推进故事。创作者可以编辑世界、WorldBook、状态 Schema、预设节点和状态栏展示。主旅程：

**世界卡库 → 世界卡/Opening/角色 + Preset + 模型 → 创建 Session → 互动 Entry → 世界线分叉/切换 → 继续。**

世界卡定义持续可编辑，Session 保存创建时的完整快照，后续修改源卡不静默影响已有故事。

## 2. 用户可感知的对象

| 对象 | 能力 |
| --- | --- |
| WorldCard | 世界、角色/扮演许可、Opening、单 WorldBook、状态 Schema、资源、发布/导入/导出 |
| Preset | 七系统节点与自定义 Prompt、role、启用、顺序、预算和条件扫描深度；可视化编辑与导入导出 |
| Provider | ProviderService 列出 Pi 内置支持的模型，用户配置/删除/验证 API Key，选择 Session 模型 |
| Session | 一局世界实例：世界卡快照、用户角色、Opening、Preset、模型和当前世界线 Entry |
| Entry | 一次互动回合，包含玩家输入和多次 AI 生成尝试 `runs[]`；`parent_entry_id` 构成世界线分叉 |
| Run（Entry 内） | 模型调用结果、AI 叙事、可选工具调用记录、全量状态快照、失败与重试 |
| AgentContext | **唯一单轮 Context**：加载历史/全状态、筛选 WorldBook/状态条目、预设节点编排，输出有序 ModelMessage[] |
| 共享 TextRenderer | 世界卡详情、Agent Prompt 和未来状态栏公用变量/条件/状态引用与受控文本处理 |
| State | 统一强类型状态定义，当前世界线完整快照存放在选中 Entry Run，AI 候选增量经验证才生效 |
| 世界线 | 只显示 Opening Root 与真正分叉点，其余互动 Entry 折叠成边；可进入真实叶子 |

## 3. 创作者与玩家体验

- **世界卡编辑**：角色可扮演许可、Opening、WorldBook 条目及 anchor/position/order/关键词/when、状态根加载条件和资源管理。
- **预设管理**：系统/自定义节点有序拖拽、启停、名称、role、内容；系统节点有自己的 NodeBuilder，从激活世界书位置索引中按 before/body/after 构建。
- **状态管理与渲染**：状态面板显示当前活动分支的**完整**世界状态；状态模板使用共享 TextRenderer。WorldBook 与状态 Module 可根据历史/输入关键词和完整状态表达式条件加载。
- **Provider 设置**：用户配置 Pi 内置模型的 API Key，支持列表/状态/验证，不提供用户自定义 Provider/Endpoint。
- **Agent Context 预览**：准确显示模型历史窗口、摘要、已匹配世界书/状态条目、最终 role 和消息顺序；不调用收费模型。
- **聊天与世界线**：一 Entry 通常显示一条 User 和一条 AI；失败可在原 Entry 重试，不制造额外分叉；从旧行动重选创建 sibling Entry，每个父节点最多三个互动 child；世界线只画 Root/Fork。

## 4. Agent 主流程

1. 载入 Session 及所选 `parentEntryId` 的真实分支历史（最近压缩 Summary + 可选近 N 消息）。
2. **独立**读取这一分支最近成功选中 Run 的全量状态，不受模型历史裁剪影响。
3. 用历史与当前 User 匹配 WorldBook、状态根的关键词/常驻/手动/when；`when` 读取完整状态。
4. WorldBook 按 anchor/position/order 建本轮索引；加载 Preset 节点顺序。
5. 调用对应系统 NodeBuilder 的 before/body/after 或自定义文本 Builder；统一 TextRenderer 进行变量/条件/状态引用/受控转换，产出 `ModelMessage[]`。
6. Pi 模型流式 SSE；成功后将叙事、可选工具记录和完整新状态写入 Entry 内被选中的 Run。

**无 WorldInstanceContext，亦无单独的 runs/messages/run_tool_calls 业务表。**

## 5. 技术与 MVP

前端 React/Vite/TypeScript H5，Hono/TypeScript 本地服务，SQLite 只保留六张业务表：`worlds`、`presets`、`provider_credentials`、`tags`、`sessions`、`entries`。`tags` 用 `type` 指向世界卡等不同对象，不建 `world_tags`；模型默认选择不需要 `app_settings` 表。

MVP：世界卡/状态/预设管理、Provider API Key、Session/Entry 分叉历史、摘要/近 N 消息、AgentContext + NodeBuilder/共享模板、状态栏、Pi SSE、Root/Fork-only 世界线。文档均为目标设计，**不代表已有实现**。

延期：多用户/分布式事务、自定义模型 Endpoint、任意来源 JS/EJS 脚本、完整插件兼容、长期记忆压缩算法策略（仅保留 summary 存储与加载机制）、图片/TTS、云端同步。

详细说明：[AgentContext](design/agent-context.md)、[TextRenderer](design/text-rendering.md)、[Session/Entry](design/session.md)、[存储](technical/storage.md)、[预设](design/preset.md)、[Provider](design/provider.md)、[世界卡](design/world-card.md)、[状态](design/state.md)、[架构](technical/architecture.md)、[实施计划](technical/implementation-plan.md)。
