# SillyRealms · 产品总纲

> 2026-11-03 产品与架构目标，尚未实现。本文确定核心用户体验与领域边界；详细协议分散在各自权威设计文档，**不以旧 Entry/Context/配置混合文档为规范**。

## 1. 产品定位

SillyRealms 是**世界卡驱动、本地优先、以持续叙事为核心**的 LLM 交互客户端。创作者设计世界、角色、世界书、开局和可选强类型状态；玩家从允许的角色中选择身份，在同一世界实例的不同 Run 世界线上推进叙事。产品不强迫所有故事转成数值模拟，不依赖 SillyRealms 云内容平台。

**主旅程：** 世界卡库 → 创建/进入世界实例 → 选择 Opening 与允许角色 → 选 Preset 和预置模型 → Chat → 压缩世界线 → 从真实路线继续。

## 2. 产品对象与用户感知

| 领域 | 产品对象和职责 |
| --- | --- |
| 世界卡（WorldCard） | 角色、Opening、单个 WorldBook、强类型状态 Schema、展示信息及资源；支持编辑、发布、导入、导出 |
| Preset | 独立管理的提示词节点预设；可编辑七系统节点和自定义文本节点的名称、Prompt、role、启停、顺序、预算；支持复制和导入导出 |
| Provider | **只允许预置 Provider 与模型**；用户选供应商/模型、配置 API Key；不开放自定义 Base URL/Provider；通过 Pi Agent 的独立 Provider 适配执行 |
| 世界实例 Session | 一次独立的故事实例，持久化选中玩家角色、世界快照、Preset ID、模型选择、强类型状态定义及 Run 树 |
| WorldInstanceContext | 会话级世界资料和运行时缓存：身份宏、世界书/状态钩子预索引、失效与压缩世界线缓存；缓存丢失可从 SQLite 重建 |
| AgentContext | **单次模型请求**的上下文构建：状态先加载，再按 Preset 顺序运行系统节点/前后钩子、只读模板和通用脚本转换，统一 Token 裁剪；输出可直接交给 Provider 的有序 Messages 数组 |
| Run | 一次互动回合，是**树结构、分页和世界线隐藏计数的最小单位**；普通 Run 包含 User 和 Assistant 两条可见 Message |
| Message | Run 内具体展示的 User/Assistant 文本，**不再直接成为树节点**；Opening Root Run 只有一条初始 Assistant Message |
| State | 世界/角色统一强类型树，Zod 校验；AI 通过受限 ChangeSet 增量更新；每个 Run 保留完整逻辑状态快照 |
| 世界线 | 只显示 Opening Root 与真正 Fork；其他 Run（包括叶子）折叠进线段，线段显示隐藏 Run 数并能进入真实终止叶子 |

## 3. 创作者的核心页面

- **世界卡编辑**：世界名称、角色列表/可扮演许可、Opening、单 WorldBook、强类型状态管理、资源；WorldBook 条目允许绑定 `personaInfo / characterInfo / worldState / userInput` 的 `before/after`，不可自定义模型消息角色。
- **状态管理**：树形添加类型字段、固定 object、动态 record、array、JSON 逃生口；作者填写名称、类型、初值、描述，系统提供校验/预览；不要求会写 JSON Patch/Zod。
- **预设管理**：独立预设列表、复制/导入导出、拖动系统节点和自定义 Prompt 节点，设置 name/role/正文/启用与预算，不展示最终世界文本实现。
- **Provider 设置**：从内置供应商选模型、输入 API Key、验证连接、设置默认/会话模型；没有用户注册供应商。
- **AgentContext 预览**（开发/高级用户）：展示实际排序的 Messages、触发了哪些 WorldBook 钩子、状态加载、模板替换结果、Token 裁剪和诊断，**不执行模型**。

## 4. 玩家与世界实例交互

用户从世界卡 `characters[]` 和 Opening 许可的交集明确选择一名 `user`，不允许外部虚构身份库；Session 保存角色快照，`{{user}}` 一直由本局角色决定。进入世界实例时恢复已持久化活动叶子 Run、世界定义及必要缓存，不重新执行 Opening。

Chat 只展示当前活动叶子的一条**Run 祖先链**，首屏读取最近约 30 **Run**，每 Run 内显示 1～2 条消息。历史只向上分页；屏幕滚动到某条历史 Message 不会自动切换世界线。发送创建新的 User Run，AI 成功后向同一 Run 添加 Assistant Message；失败/取消保留 Run 与 User Message 供重试。

历史分叉从旧 Run 的**父 Run** 新增一个兄弟 Run，形成不同玩家行动选择；同一父 Run 最多三个直接分支。全局世界线只画 Root/Fork 和压缩线段，不显示非分叉 Run、Branch Start 或叶子节点；每段标注折叠 Run 数，终止线保留真实 `terminal_leaf_run_id` 以便选择“进入这条世界线”。点击线条预览与确认进入分离，只有确认才更新活动叶子。编辑历史 Message 不自动改写后代，但会使受影响的状态/摘要失效。

## 5. 技术边界与发布目标

前端 React/Vite/TypeScript H5；本地服务 Hono/TypeScript；SQLite 唯一权威；Pi Agent 执行层。模型连接与 Prompt 构建彻底分层：**Preset 只描述如何编排，AgentContext 构建 Messages，Provider 负责模型执行，StateEngine 结算 Run 状态**。世界卡脚本导入可以保存为来源资料，但不自动执行任意 JS；安全的状态表达式和声明式文本转换在 AgentContext 中完成。

MVP：世界卡管理、强类型状态编辑、Preset 配置/导入导出、预置 Provider/模型密钥设置、WorldInstanceContext 进入重建、AgentContext 编排预览、Run 级聊天分页、Root/Fork-only 压缩世界线、真实分叉/重试、Pi 可验证模型执行与独立状态面板。**均为目标，不是已有实现**。

延期：自定义 Provider/兼容 URL、OAuth 订阅登录、复杂可执行脚本、完整 SillyTavern 插件兼容、图片/TTS、长篇记忆压缩、消息删除、任意历史中间浏览、云端/多端同步和完整世界线画布。

## 6. 文档入口

产品领域：[世界卡](design/world-card.md)、[Preset](design/preset.md)、[Provider](design/provider.md)、[AgentContext](design/agent-context.md)、[WorldInstanceContext](design/world-instance-context.md)、[Session/Run](design/session.md)、[State](design/state.md)。技术实现：[架构](technical/architecture.md)、[存储](technical/storage.md)、[任务规划](technical/implementation-plan.md)。
