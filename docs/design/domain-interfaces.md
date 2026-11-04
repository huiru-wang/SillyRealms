# 领域 Service：围绕产品链路的能力与接口

> 2026-11-04 目标设计，尚未实现。本文件只列**具有业务含义、需要由产品或运行时调用的 Service 方法**。数据库 Repository、纯函数校验器、Pi SDK 原生方法不等于领域接口。具体返回 DTO 在实现时统一定义。

## 1. 用户操作主链路

| 用户场景 | 产品操作 | 服务调用与实际作用 |
| --- | --- | --- |
| 首页继续游玩 | 查看近期世界会话、点进某个会话 | `SessionService.listSessions` → `getSession` → `getChatPage`，直接恢复上次选中的世界线 |
| 发现世界 | 世界卡列表、查看详情与开局/角色 | `WorldService.listWorlds` → `getWorld`；完整世界卡已含 `openings[]` / `characters[]` / `lorebook`，无需单独拉取 |
| 创建故事 | 选开局、可扮演角色、预设并进入 | `SessionService.createSession` 校验当前 World/Preset 和角色，写入 Session 与 Opening 根 Assistant Entry（含 S0） |
| 继续叙事 | 输入并发送 | `AgentRuntime.run` 读取本轮 Context、创建新 Run、落库所有 User/Assistant/ToolResult/技术 Entry，推送 SSE；下次仅用叙事投影作为模型历史 |
| 查看旧消息 | 上滑加载、切换世界线 | `getChatPage` 按**Run**分页当前分支；`getWorldlines` 查看分叉概要；`switchWorldline` 只切选中 tip |
| 修改历史 | 从旧 User 重走不同剧情、重生成/续写最后 AI | `forkFromUserMessage` / `regenerateLastAssistant` / `continueLastAssistant`，由 Runtime 执行后续生成；旧世界线完整保留 |
| 调整模型 | 设置页选 Provider、配置密钥、测试；预设页选模型与 Token 上限 | `ProviderService.listProviders/listModels/saveApiKey/testConnection` → `PresetService.updatePreset`；每轮使用最新 Preset 配置 |
| 删除世界 | 世界卡详情页二次确认后删除 | `WorldService.deleteWorld` **级联清除世界卡、全部会话及所有分支 Entries、摘要、状态与独占资源**；不要求先手动删除会话 |

以下是**Service 层**的最小公开能力；例如 `appendMessage` / `getRawAncestorEntries` / `getModel` / `validateTagRefs` 都是 Service 内部使用的存储或辅助操作，不作为另一套业务 API 对外提供。

## 2. WorldService：世界卡的创建、管理和详情

| 接口 | 产品链路 / 服务职责 |
| --- | --- |
| `listWorlds(query?, cursor?, limit?)` | 世界卡库搜索、标签过滤和分页，返回卡面摘要而非完整 lorebook |
| `getWorld(worldId)` | 世界卡详情及编辑页的**完整当前数据**：角色、允许扮演标记、开局、lorebook、状态、策略和资源引用；AgentContext 每轮也读取同一份最新定义 |
| `createWorld(data)` | 新建世界卡并校验角色 ID、开局、资源引用和状态 Schema |
| `updateWorld(worldId, patch)` | 编辑世界卡及角色、开局、lorebook、状态和资源；下一轮 Session 立即读取更新后的当前版本 |
| `deleteWorld(worldId)` | 用户二次确认后，在服务端原子删除世界卡及它的全部 Session/Entry；同时清除相关独占本地资源，详见 [Storage](../technical/storage.md) |
| `importWorld(file)` | 解析来源格式/资产，预览校验后导入为当前原生世界卡，不自动执行来源脚本 |
| `exportWorld(worldId)` | 导出完整世界定义和可打包的自有资源，不导出 Session、API Key |

**不提供** `getPlayableCharacters`、`getOpening`、`getWorldSnapshot`。详情页直接用 `getWorld` 返回的数组筛出 `player_selectable=true` 的角色并选开局；创建 Session 时必须在服务端**再次校验**，避免旧客户端数据。AgentContext 读取 `getWorld` 的本轮内存值即可；这里的“只读”不是额外版本或可复用的历史快照。

## 3. PresetService：运行时 Prompt 与模型配置

| 接口 | 产品链路 / 服务职责 |
| --- | --- |
| `listPresets()` | 新建会话、预设管理页展示候选预设 |
| `getPreset(presetId)` | 完整当前配置：模型、生成参数、`max_context_tokens` / `max_output_tokens`、摘要模板、节点和编排；AgentContext 每轮使用同一读取口 |
| `createPreset(data)` | 创建/复制/从 UI 草稿新建预设，校验默认节点约束与模型选择；复制通过以已有数据创建新记录完成 |
| `updatePreset(presetId, patch)` | 保存模型/预算/Prompt/节点配置，影响相关会话的**下一次运行** |
| `deletePreset(presetId)` | 删除非内建且未被 Session 引用的预设；被引用时明确拒绝 |
| `importPreset(file)` | 校验并建立一个新预设，不导入或引用密钥 |
| `exportPreset(presetId)` | 导出完整脱敏预设供备份/分享 |

**不提供** `restoreDefault`、`getPresetSnapshot`、独立 `clonePreset`。内建预设可编辑但不可删除；复制是 `getPreset` + `createPreset` 的业务组合。单轮运行只读取一次当前 Preset，使用不可变本地值保证这一轮配置一致，无需持久快照或双重查询。

## 4. ProviderService：模型目录、凭据、连通性

| 接口 | 产品链路 / 服务职责 |
| --- | --- |
| `listProviders()` | 设置页显示受支持 Provider 与**已配置凭据**状态（布尔值），不回显 Key |
| `listModels(provider)` | 模型选择器展示此 Provider 的支持模型、上下文/输出硬上限、模型能力与是否具备本地认证条件 |
| `saveApiKey(provider, key)` | 用户添加/替换凭据，安全写入 CredentialStore，不写预设或 Session |
| `deleteApiKey(provider)` | 从 CredentialStore 删除凭据；已有 Preset 保留模型 ID，下次调用提示重新配置 |
| `testConnection(selection)` | 用户明确点击“测试连接”，才发送一次最小真实请求，返回成功或脱敏错误，可能消耗 Token |
| `resolveModel(selection)` | **内部运行时口**：校验受支持模型和凭据，返回 Pi 可使用的 Model/认证上下文，失败直接报错，绝不替换成其它模型 |

**不提供** `hasApiKey`、`getModel`、`getAvailableModels`。配置状态已包含在列表 DTO 中；`listModels` 统一用于模型选择，`resolveModel` 统一用于运行校验。**“已配置”不等于“连接成功”**，测试才是实时校验。目录与协议复用 Pi，不为每个 Provider 新造一套 Adapter。详见 [Provider](provider.md)。

## 5. TagService：世界卡分类标签

| 接口 | 产品链路 / 服务职责 |
| --- | --- |
| `listTags(type)` | 世界卡筛选/编辑时读取按类型和顺序组织的标签 |
| `createTag(type, name)` | 增加一个该类型下名称唯一的标签 |
| `renameTag(tagId, name)` | 更改标签显示名称 |
| `reorderTags(type, orderedIds)` | 标签管理页保存同类型内的新排序 |
| `deleteTag(tagId)` | 删除标签并移除其世界卡引用，或在无法安全清理时明确失败 |

`validateTagRefs` 是世界卡写入时调用的内部校验函数，不独立对外。

## 6. SessionService：会话、历史和世界线

| 接口 | 产品链路 / 服务职责 |
| --- | --- |
| `createSession(worldId, openingId, userCharacterId, presetId)` | 创建游戏：校验当前世界卡、可扮演角色/开局、预设；新建 Session，Opening 作为首条 Assistant Entry，附初始状态 S0 |
| `listSessions(cursor?, limit?)` | 首页“最近继续”列表，返回标题、世界卡摘要、最近活动时间 |
| `getSession(sessionId)` | 进入会话：读取关联 world/preset/玩家角色、当前 tip 和基本信息 |
| `updateSession(sessionId, patch)` | 会话详情修改标题或有效角色/预设；不重写旧消息或状态 |
| `deleteSession(sessionId)` | 单独删除这条会话、**所有分支** Entries 和会话独占资源；不删除世界卡 |
| `getChatPage(sessionId, cursor?, limit=10)` | 聊天上滑分页：限定当前 tip 的祖先链，按 **Run** 游标分页，只投影 user/assistant 的可见叙事，绝不拆 Run |
| `getWorldlines(sessionId)` | 世界线概览：仅返回 Root、分叉点、每支首条/叶子及折叠 Run 数 |
| `switchWorldline(sessionId, leafEntryId)` | 选中世界线叶子，将 Session.tip 指向该叶子，旧分支不删除，UI 清除原分页游标 |
| `forkFromUserMessage(sessionId, historicalUserEntryId, newText)` | 在历史 User 的父 Entry 后建立新的兄弟 User 和新 Run，再由 Runtime 对该 User 生成；默认进入新线 |
| `regenerateLastAssistant(sessionId)` | 仅对当前最后一个可重生成 AI 回复新建 Assistant 分支，复用其 User 的逻辑 run_id，再由 Runtime 生成 |
| `continueLastAssistant(sessionId)` | 仅对当前分支最后一条 Assistant 续写，保留原回复和关联完整 Raw Entries，由 Runtime 继续生成 |

**不作为独立公开 Service 接口**：`getEntry`、`getRawAncestorEntries`、`appendMessage`、`appendTechnicalEntry`、`appendSummary`、`getRunPage`、`getNarrativeContext`、`getCurrentState`。它们分别是内部 EntryRepository、Run 查询/投影器、StateService 或 AgentContext 的实现细节。需要开发者调试 Raw Entries 时用有权限的诊断入口，不等于普通 SessionService API。

## 7. StateService：状态初始化、读取与结算

| 接口 | 产品链路 / 服务职责 |
| --- | --- |
| `buildInitialState(world, opening)` | 创建 Session 时合并世界卡初值与 Opening 覆盖，经 Schema 校验得到 S0 |
| `getCurrentState(sessionId, tipEntryId, world)` | 状态栏和 AgentContext 沿当前 Raw 父链读取最近有效完整状态；与窗口/摘要无关，旧 Schema 不兼容可重置 |
| `buildStatePrompt(world, narrative, fullState)` | 按压缩前候选叙事关键词与 when(fullState) **一次性**选中状态根，生成 worldState Prompt 和本轮工具可操作范围；随后压缩历史不重算 |
| `finalizeTurnState(world, previousState, toolOrInlineChanges)` | 解析、校验并应用本轮状态变更，生成带 reason 的 ChangeSet 与完整 S'，交给最终 Assistant Entry 持久化 |

`selectActiveModules`、`parseStateChanges`、`validateStateChanges`、`applyStateChanges`、`serializeStateForPrompt` 都是以上 Service 方法调用的内部纯函数，仍可分别单测，但不作为对外 API。

## 8. AgentContext / AgentRuntime：本轮模型调用

| 接口 | 产品链路 / 服务职责 |
| --- | --- |
| `AgentContext.create({sessionId,parentEntryId,userInput})` | 每轮加载当前 Session、World、Preset、Raw 祖先和 State，确定 window/summary 与 lorebook 命中 |
| `AgentContext.buildMessages()` | 按预设一次构建 Prompt 并将候选历史、当前 User 组装成 ModelMessage[]；压缩仅替换历史位置，最后校验完整 Token 预算 |
| `AgentRuntime.run({sessionId,userInput?,continuation?})` | 普通发送/分叉后回复/重生成/续写的统一执行入口：Run 协调、Pi Agent 调用、每条完整 Raw Entry 落库、SSE、最终状态结算 |
| `AgentRuntime.stop(sessionId)` | 用户点击停止，取消在途生成并保留已完成 Entry，恢复可续聊状态 |

**不把 Repository 包装成 Service**：Raw 写入、祖先递归 SQL、内部技术 Entry 分类、Provider 凭据读取和状态纯函数仍然存在，只是不占据产品领域 API 面积。

## 9. 一致性和删除边界

- 世界卡和预设**没有持久 Session Snapshot**。每轮开始读取最新值并在本轮内固定使用；编辑仅影响之后的运行。
- `sessions` 不需要 `role`；`entries.role` 仅当 `type=message` 时记录 `user/assistant/toolResult`，技术 Entry 为 NULL。可直接按角色筛选后，再限制到**当前 tip 祖先链**。NarrativeProjection 仍过滤 Assistant 内 toolCall/thinking。
- Pi Entry 的 `type` 保持 `message/compaction/branch_summary/custom`，产品特有的 Custom 子类型写 `entries.sub_type`，适配 SDK 时映射为 `customType`。Window 不写摘要；Summary 是应用控制的 `custom + sub_type=sillyrealms.summary`，与 Fanto 使用 Pi 原生 Compaction 不混淆。
- 世界卡删除会级联其全部 Session 和 Raw Entries（包含所有 Run、分支、技术摘要、嵌入的 State）。仅清理该世界/会话**独占**文件，不删除全局 Provider 密钥、Preset、标签或被其它世界使用的共享文件；必须有故障恢复的资源清理机制。
- UI 只需配置 `max_context_tokens` 与 `max_output_tokens`。Provider 的 `contextWindow/maxTokens` 为硬上限；Token 估算安全余量属于内部固定策略，不进入 JSON、API 或前端表单。

关联：[WorldCard](world-card.md)、[Preset](preset.md)、[Provider](provider.md)、[Session](session.md)、[Storage](../technical/storage.md)、[Context Strategy](context-strategy.md)。
