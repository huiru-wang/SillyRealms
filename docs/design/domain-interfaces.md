# 领域接口清单：每个接口的单句职责

> 2026-11-04 设计稿，尚无正式代码实现。这里列的是**领域 Service 接口**，不等于 HTTP Route、Pi SDK 原生方法或数据库 Repository。目标是精简、便于前后端划分；状态/Token/世界线算法以各专项文档为准。

## 1. WorldService

| 接口 | 作用 |
| --- | --- |
| `listWorlds(query?, cursor?, limit?)` | 按搜索、标签与游标列出世界卡摘要 |
| `getWorld(worldId)` | 读取当前唯一世界卡内容 |
| `createWorld(data)` | 校验并保存一张新世界卡 |
| `updateWorld(worldId, patch)` | 编辑当前卡，包括角色/开局/lorebook/状态/上下文策略 |
| `deleteWorld(worldId)` | 删除未被 Session 使用的世界卡或提示先处理引用 |
| `importWorld(file)` | 解析来源并规范化到当前 WorldCard 格式，不自动执行未知脚本 |
| `exportWorld(worldId)` | 导出当前原生世界卡及允许的资源引用 |
| `getPlayableCharacters(worldId)` | 返回当前世界卡可由玩家选择的角色列表 |
| `getOpening(worldId, openingId)` | 读取并验证创建 Session 使用的指定开局 |
| `getWorldSnapshot(worldId)` | 给一次 AgentContext 构建提供当前世界卡的完整只读值，不持久化会话快照 |

角色的创建/修改可通过 `updateWorld` 操作 `characters[]`，无需额外建角色表。相关规范：[WorldCard](world-card.md)。

## 2. PresetService

| 接口 | 作用 |
| --- | --- |
| `listPresets` | 列出可选预设 |
| `getPreset` | 读取完整预设 |
| `createPreset` | 创建并校验预设 |
| `clonePreset` | 复制预设为新记录 |
| `updatePreset` | 更新模型、Token 预算、摘要 Prompt、节点顺序 |
| `deletePreset` | 删除非内建且不被引用的预设 |
| `importPreset` | 校验并导入脱敏预设 |
| `exportPreset` | 导出不带密钥的预设 |
| `restoreDefault` | 恢复内建默认预设内容 |
| `getPresetSnapshot` | 提供一次 AgentContext 读取所需的当前配置 |

相关规范：[Preset](preset.md)。

## 3. ProviderService

| 接口 | 作用 |
| --- | --- |
| `listProviders()` | 返回允许的 Pi 内置供应商 |
| `listModels(provider?)` | 查询模型列表及 contextWindow 等能力 |
| `getModel(selection)` | 校验模型选择并读取展示元数据 |
| `getAvailableModels(provider?)` | 查询本地认证配置齐全的模型，不保证远端在线 |
| `hasApiKey(provider)` | 判断供应商凭据是否已配置 |
| `saveApiKey(provider, key)` | 安全写入/替换用户凭据 |
| `deleteApiKey(provider)` | 删除已保存凭据 |
| `testConnection(selection)` | 明确发起一次最小模型连接测试 |
| `resolveModel(selection)` | 给 AgentRuntime 解析实际 Pi Model，不回显密钥 |

相关规范：[Provider](provider.md)。

## 4. TagService

| 接口 | 作用 |
| --- | --- |
| `listTags(type)` | 按 type 内 sort_order/name 稳定排序列出标签 |
| `createTag(type, name)` | 创建标签并检查同类型名称唯一性 |
| `renameTag(tagId, name)` | 修改标签名称 |
| `reorderTags(type, orderedIds)` | 批量更新该类型标签的显示顺序 |
| `deleteTag(tagId)` | 删除标签并清理/阻止失效引用 |
| `validateTagRefs(type, ids)` | 验证世界卡等保存的标签 ID 属于指定 type |

## 5. SessionService

| 接口 | 作用 |
| --- | --- |
| `createSession` | 从 Opening 建立 Session + 初始化 Run/根 Assistant/S0 |
| `listSessions` | 分页展示会话列表 |
| `getSession` | 获取 Session 及当前 tip |
| `updateSession` | 更新标题、有效玩家角色或预设关联 |
| `deleteSession` | 明确删除 Session 和 Entries |
| `getEntry` | 读取指定 Raw Entry |
| `getRawAncestorEntries` | 沿选中 tip.parent_id 读取完整祖先链 |
| `appendMessage` | 保存真实 user/assistant/toolResult Message，带 run_id |
| `appendTechnicalEntry` | 保存 Pi 或产品技术 Entry |
| `appendSummary` | 保存 custom/sillyrealms.summary 及覆盖边界 |
| `getRunPage` | **按 Run 数作为 limit** 对当前世界线分页返回全部 Raw Entries |
| `getChatPage` | 同 Run 分页，按 NarrativeProjection 返回可见故事 |
| `getCurrentState` | 返回当前世界线最新有效完整 State |
| `forkUserMessage` | 创建兄弟 User，新 run_id |
| `regenerateAssistant` | 原 User 下新建 Assistant 分支，沿用逻辑 run_id |
| `switchTipEntry` | 切换选中世界线的 tip |
| `getCompressedWorldlines` | 生成 Root/Fork-only 分叉图 |
| `getNarrativeContext` | 提供原始历史叙事投影候选给 AgentContext |

详细参数、Run 游标、分叉逻辑与示例：[Session](session.md)。

## 6. StateService

| 接口 | 作用 |
| --- | --- |
| `buildInitialState(world, opening)` | 从当前状态 Schema 初值与 Opening 覆盖生成 S0 |
| `getCurrentState(ancestors, currentWorld)` | 沿原始消息父链找最新有效全量状态，Schema 不兼容时重置 |
| `selectActiveModules(world, narrative, fullState)` | 根据最终叙事关键词与 when(fullState) 筛选状态根 |
| `parseStateChanges(output)` | 从本轮工具或内联协议解析候选状态变更 |
| `validateStateChanges(schema, changes)` | 校验变更的 path、操作、类型、reason 等 |
| `applyStateChanges(fullState, changes)` | 校验成功后计算完整 S'，不得原地改历史快照 |
| `serializeStateForPrompt(activeModules, fullState)` | 生成 worldState 节点的有序只读描述 |

相关规范：[State](state.md)。Context 的状态读取与 Session 只共享一份权威状态逻辑，不各自实现。

## 7. AgentContext / AgentRuntime（非持久业务表）

| 接口 | 作用 |
| --- | --- |
| `AgentContext.create(input)` | 读取世界卡/预设/原始分支，计算 State、Window/Summary 和最终命中 |
| `AgentContext.buildMessages()` | 建立最终 ModelMessage[] 并检查完整 Prompt Token 预算 |
| `AgentRuntime.run(sessionId, userInput)` | 创建/沿用 Run，调用 Pi，逐条保存 Agent Entries 并推送 SSE |
| `AgentRuntime.stop(sessionId)` | 请求停止该 Session 当前推理并保留已成型消息 |

`AgentContext` 负责 Prompt 规划，不执行模型；`AgentRuntime` 负责本轮实际调用，不复制世界快照。相关：[AgentContext](agent-context.md)、[技术架构](../technical/architecture.md)。

**所有 API 均处于设计阶段，具体 TypeScript 参数/返回类型以落地时的共享 DTO 为准；职责边界已明确，不要从接口名推导为新的数据库表。**