# SillyRealms 单 Context / Entry 精简设计实施计划

> 2026-11-03 第二版设计，**尚未实施**。权威协议在 `docs/design/*` 与 `docs/technical/*`；本计划与外层 `plan/sillyrealms-domain-refactor-tasks.md` 保持内容相同。

## 0. 已确定的关键决策

| 模块 | MVP 方案 |
| --- | --- |
| AgentContext | **一个 Context**：加载 Session/分支历史/最近全量状态；条件匹配世界书与状态；按位置建索引；按 Preset 节点顺序经可扩展 NodeBuilder 组装；统一文本渲染；输出 `ModelMessage[]` |
| Text Renderer | 独立 `domain/text`，共享变量/条件/状态引用与受控文本转换，供 Agent、世界卡详情及状态栏 |
| Session/Entry | Session 有世界卡快照、Preset、ModelSelection、activeEntry；Entry 含 parent 指针与 `runs[]`，每个成功 Run 保存完整状态 |
| 历史 | 最近 summary 截断 + 可配置近 N 条可见消息；状态读取独立于裁剪；关键词扫描深度独立 |
| Provider | 保留 ProviderService，调用 Pi 内置模型/凭据目录，用户配置 API Key |
| SQLite | **仅六张业务表**：`worlds / presets / provider_credentials / tags / sessions / entries`；无 Run/Message/ToolCall/AppSettings/WorldTags/Checkpoint 表 |
| 本地执行 | 一个 Session 一条在途请求，必要两行更新用 SQLite 短事务；没有复杂并发体系 |

## 1. 阶段 A：PoC 和协议

- [ ] A1. 固定兼容 Pi SDK 版本，验证完整有序 ModelMessage[] → 真实 HTTP 请求的保序和 User 去重（特别是 postHistory system），以及 SSE/取消。
- [ ] A2. 验证 Pi 内置 `getProviders/getModels/getModel/getAvailable`、CredentialStore 及实际 Provider Key 连接，Tool Calling 和长叙事在模型级的支持情况。
- [ ] A3. 固定 `Entry` 数据形状（`parent_entry_id / runs_json / selected_run_id`）及 Opening、重试、Summary、分叉的 JSON 样例；不建独立 Run/Message 表。
- [ ] A4. 固定通用 `TextRenderer` 对外接口，保证同一 `when` 表达式在状态模块、WorldBook 和 UI 中语义一致。

## 2. 阶段 B：六表领域存储

- [ ] B1. 建立 `worlds/presets/provider_credentials/tags/sessions/entries` 六张 SQLite 表、最小索引和 `PRAGMA user_version` migrations；不建其它业务表。
- [ ] B2. `SessionService` 实现创建世界实例 + Opening Entry/S0、历史父链、可见消息历史、最近成功 Run 全状态、同 Entry 运行重试、简单分叉/切叶子、最近 Summary 和近 N 消息截断。
- [ ] B3. `PresetService` 按 `nodes[]` 处理系统/自定义节点与导入导出，配置 `scan_depth_entries` 和预算；无 revision CAS 等多用户锁。
- [ ] B4. `ProviderService` 列出 Pi 支持的模型、用户 Key 的安全引用保存/删除/显式测试；创建 Session 必须指定 ModelSelection，不建 `app_settings`。
- [ ] B5. `tags` 通过 `type/target_id/name` 适配世界卡、预设、会话标签，不建 `world_tags`。

## 3. 阶段 C：Context、文本和状态

- [ ] C1. 独立 `domain/text` 完成变量替换、`{{state:/...}}`、只读布尔表达式/if、受控替换/正则处理，提供 Agent/世界卡/未来状态栏共同入口。
- [ ] C2. `AgentContext.create`：加载 Session，按分支父 Entry 读取历史（summary + N 条边界），独立找到最近选中成功 Run 的全状态。
- [ ] C3. 同一轮扫描历史+输入；根据完整状态匹配 `always/on_mention/manual/when` 的 WorldBook 与状态根，按 anchor/position/order 形成 WorldBook 索引。
- [ ] C4. 实现七系统 NodeBuilder 和 CustomTextNodeBuilder，按 Preset 顺序执行，系统节点拉 before/body/after，统一调用 TextRenderer 生成 ModelMessage[]；模型窗口超限时基于完整 Entry 裁剪。
- [ ] C5. StateEngine 用 AgentContext.activeStateModules 构造工具范围并校验结果，成功 Run 的 `stateSnapshot` 为完整值，失败不覆盖已选 Run。

## 4. 阶段 D：Pi/SSE 与 UI

- [ ] D1. AgentRuntime 每 Session 简单在途互斥；`Entry.runs[]` 记录成功/取消/失败/重试及内部 Pi ToolCall/Result，SSE delta 不落库。
- [ ] D2. 世界卡详情和状态面板使用共享 TextRenderer；Preset/Provider 设置、Agent Context Preview 按最终消息顺序展示。
- [ ] D3. Chat 按 Entry 分页、Root/Fork-only 压缩世界线、选择真实叶子、历史 sibling 分叉；Summary 技术节点不算玩家回合。
- [ ] D4. 世界卡编辑/发布与 Session 快照隔离；Schema 变动不静默改变现有历史的状态定义。

## 5. 测试、验收与回退

- [ ] E1. AgentContext 单测：Summary 截断、近 N 消息、scan_depth_entries、读取全状态不被裁剪、分叉隔离。
- [ ] E2. 世界书 + 状态根的 `when` 与关键词条件、order 稳定排序、before/body/after、系统节点关闭但挂钩仍启用、统一 TextRenderer 只执行一次。
- [ ] E3. Entry 模型：Opening S0、失败后同 Entry 重试、多个 Run 选择、工具消息隔离、状态更新失败不提交错误快照、同一分叉最多 3 个 child。
- [ ] E4. UI：世界卡状态渲染、标签类型筛选、世界线隐藏互动 Entry 数、跨分支状态不串线；六张业务表检查通过。
- [ ] E5. 真实数据迁移前备份；若已有旧 `runs/messages` 实验表，显式转换并验证，不自动覆盖玩家数据；Pi 真实模型差异必须复测。

不在本期实现多端/多用户并发、复杂 revision 系统、独立 Provider Adapter、自定义 Base URL、任意 JS/EJS 执行、复杂消息上下文缓存。产品能力必须以通过的 PoC 和端到端测试为准，而非设计文字。
