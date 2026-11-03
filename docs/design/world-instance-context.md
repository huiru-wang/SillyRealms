# WorldInstanceContext：世界实例的运行时上下文与缓存

> 2026-11-03 目标设计，未实现。WorldInstanceContext 代表**一个 Session 的世界资料投影和生命周期缓存**，不同于 [AgentContext](agent-context.md) 的单次调用构建。它保存**静态定义索引/轻量缓存**，不替代 SQLite 中的世界卡、Run、Message 和状态快照。世界定义和选中身份来自 Session 已持久化的数据，不在这里做永久第二份权威存储。

## 1. 产品与范围

世界实例进入时必须能够恢复用户上次选定的角色、当前真实世界线、世界书启停选择、强类型状态定义和最新完整状态。角色宏 `{{user}}` 应与此世界实例一致；不同世界实例即使引用同一世界卡，也拥有自己的运行历史和状态。

本模块负责 **加载/缓存/索引/查询/失效**：
- 已发布世界卡的本局快照（背景、角色、单个 WorldBook、强类型状态定义）；
- 当前世界实例选定玩家角色及宏（`{{user}}` 等）；
- WorldBook、角色条目和状态 Module 的**按锚点分类与稳定排序**，供 AgentContext 按本轮文本/状态决策；
- 本局 WorldBook 手动启用/禁用集合和其修订号；
- 真实世界线的轻量 Run 元数据和**压缩拓扑缓存**；
- 本局状态 Schema 编译结果的可丢弃缓存，以及从选定父 Run 读取快照的查询委托。

不负责：拼完整 Prompt、执行用户脚本、Token 预算、Provider 选择、模型调用、跨 Run 永久缓存“本轮已激活状态”，或把叙事文本当权威世界状态。

## 2. 领域对象

~~~text
Session (SQLite 权威)
 ├─ world_snapshot_json / world_snapshot_revision
 ├─ user_character_id / user_character_snapshot_json
 ├─ preset_id / model_selection_json
 ├─ context_options_json / context_options_revision
 ├─ state_definition_json / state_schema_hash
 ├─ active_leaf_run_id / run_tree_revision / run_content_revision
 └─ Runs / Messages / Run.state_snapshot_json
             |
             v
 WorldInstanceContext (可丢弃内存视图)
 ├─ WorldDefinitionIndex
 │   ├─ characterById / selectedPersona
 │   ├─ loreByHook: [anchor.before, anchor.after]
 │   ├─ stateModuleByName
 │   └─ assetAndDisplayRefs
 ├─ Macros: {{user}} 等
 ├─ ManualLoreOptions
 ├─ CompiledStateSchemaCache
 └─ CompressedRunTopologyCache
~~~

**重要区分**：`state_definition_json` 是 Session 级冻结 Schema；**运行状态值归各 Run 的 state_snapshot_json**，依世界线父链继承。WorldInstanceContext 不保存“当前全局唯一状态对象”，否则在分叉切换后会串线。只有 AgentContext 开始时从指定父 Run 取得冻结状态值。

### 2.1 WorldBook 预索引

单个世界卡中的 `lorebook.entries[]` 在加载时校验唯一 ID，按 `(anchor, position, order, 原始数组序号)` 稳定排序并编译为：

- `getHookCandidates("personaInfo", "before")` / `after`；
- 同理 `characterInfo`、`worldState`、`userInput`；
- `getCharacterCandidates()`：角色本身 `load`、角色资料与当前 user 角色排除；
- `getStateModuleCandidates()`：状态根定义（含 `load`）、稳定声明顺序和已编译校验器。

**这里只做索引，不在加载时判断关键词/when**：触发取决于单次当前 Run 用户输入、祖先 Run 文本和父状态，由 AgentContext/StateLoader 计算。`manual_lore_ids` 和 `disabled_lore_ids` 是 Session 持久化选择项；`disabled` 优先于自动命中。数据索引不复制整个 Prompt 的最终文本，避免缓存含旧状态插值的字符串。

### 2.2 角色宏与开局

Session 创建时必须从世界卡 + Opening 的许可集合中明确选中一个 `user_character_id`，保存角色完整定义快照。`getPersona()` 返回这个稳定快照；`getMacros()` 至少提供 `{"user": 角色名称}`。角色显示资料更新时，是否更新本局身份快照必须显式操作；不能由于世界卡同步而暗改用户身份。开局只在创建 Session 时从 Schema 默认值 + Opening 部分覆盖生成根 Run 的状态，**进入/退出世界实例不重复执行 Opening**。

## 3. 生命周期：默认易懂的“进入重建、期间按版本失效”

首期不需要为一个实例常驻复杂后台 Agent。打开 Session / 从外部返回实例时：

1. 从 SQLite 读取 Session、当前世界卡快照、角色快照、Context 选项、Schema hash、活动叶子 Run；
2. 一次性构建静态索引、只读宏、Schema 编译缓存；从 Run 仓库读取活动叶子和必要的轻量世界线树信息；
3. 返回标记 `world_snapshot_revision / context_options_revision / state_schema_hash / run_tree_revision / run_content_revision` 的不可变 `WorldInstanceContextView`；
4. 每次 AgentContext 构建取得一份固定视图；会话实例关闭时可以释放。服务端可用按 sessionId 的 LRU/短期内存缓存加速，但缓存可随时丢弃，下一次从 SQLite 确定性重建。

初期**直接在每次进入重新构建**最稳妥；在实例内有变更时按下表失效，不在同一次执行里混合旧/新索引。如果缓存 revision 不匹配，必须从事实来源重建，不能返回仅依赖旧哈希的过期结构。

## 4. 缓存与失效矩阵

| 发生变化 | 必须失效 / 重建 | 保留 |
| --- | --- | --- |
| 世界卡实例手动同步、世界资料内容/触发/锚点/order 改变 | WorldDefinitionIndex、宏所依赖的角色展示映射、WorldBook 预索引、相关 Prompt/预览缓存 | Run/Message 历史、原状态快照和已选 user ID |
| 世界卡状态定义升级并完成显式迁移 | 编译 Schema、类型目标索引、受影响 Prompt/状态预览缓存 | 已按迁移规则保留的历史 |
| 本局切换玩家身份（若将来支持） | Persona 与宏、相关预览/AgentContext；必须校验身份合法和状态迁移影响 | Run 原始文本，不自动替换历史用户名 |
| 本局手动禁用/启用 WorldBook | 相关 Hook 选择与构建缓存 | 静态排序索引无需完全重编 |
| 新建/完成/重试 Run | Run 元数据/世界线拓扑、最新叶子和状态读取缓存、后续 Context | 静态 WorldBook 索引 |
| 切换活动 Run 叶子 | 当前叶子状态投影和前端 Chat 页游标；重算高亮路径 | 与父子结构无关的压缩拓扑可复用 |
| 编辑 Run 内 Message / AI 重生成 | 对应预览摘要、该 Run 及后代的 Context/状态依赖、必要拓扑预览缓存 | 仍有效的祖先、静态世界卡索引 |
| 修改 Preset | 不影响 WorldInstanceContext 静态索引；下一 AgentContext 用新的 PresetSnapshot | Run 历史及旧生成快照 |
| 修改 Provider/Key | 不影响 WorldInstanceContext 与 AgentContext 内容（预算输入另行冻结） | 所有世界定义缓存 |

数据库中需要有**可比较的修订号**（`world_snapshot_revision`、`context_options_revision`、`run_tree_revision`、`run_content_revision`、`state_schema_hash`），更新这些对象时原子递增/替换。若尚未实现细粒度修订，MVP 可直接在操作后删除整个 sessionId 的 Context 缓存并重建，避免过早构建复杂失效系统。对外已冻结的视图要能携带版本戳供 AgentService 的提交校验。

## 5. 压缩世界线：按 Run 构图和增量缓存

**每个 Run 是一个真实树节点**；普通单链 Run 被压成边，消息只是 Run 内内容，**隐藏数量 = 边上被折叠的 Run 数**，不是 Message 数或 token 数。全局可见 Run **只有 Root 和 Fork（有至少两个 Run 子节点）**；Branch Start、普通 Run、Leaf **均折叠进连线**，不独立绘制。终止边保留 `terminal_leaf_run_id`，可据此进入真实叶子；`collapsed_run_count` 统计该段没有绘制的 Run（终止边包含 Leaf 本身）。缓存只保留 `run_id, parent_run_id, status, preview_excerpt, child_count` 等轻量元数据，不缓存全量正文。明细规则见 [Session](session.md)。

由于 MVP 不删除 Run，Run 树结构主要只有追加，因此**可以增量维护**：

- 在单链末尾追加子 Run：原终止边的 `terminal_leaf_run_id` 指向新 Run，`collapsed_run_count` 加 1；旧叶子和新叶子都不产生可见节点。
- 从历史 Run 发出第二个子 Run：它由普通节点变为 Fork，**必须把原压缩边拆开并显式呈现这个真实 Run**，为该 Fork 的两个分支生成**边**，各边记录 `branch_start_run_id`，而非创建可见 Branch Start 节点；旧边隐藏计数重新计算。
- 新的第三个子 Run：Fork 从 2/3 变为 3/3；第四个拒绝。
- 原有 Message 变更/重生成：拓扑结构不变，但该 Run 摘要和状态徽标失效；不能复用老预览。
- 切换活动叶子：结构不变，仅重算当前选中 Run 的祖先链高亮。

首期允许用轻量 Run 元数据 **O(本 Session Runs 总数)** 确定性重建压缩拓扑，作为增量缓存的正确性校验与故障回退。缓存键建议 `(sessionId, run_tree_revision, run_content_revision)`，大树需支持子树展开与明确 `has_more`，不能伪造已完整加载。**Run 树唯一权威仍在 SQLite**；缓存丢失可恢复、绝不将缓存写回代替数据库。

## 6. 对外读取契约

~~~ts
interface WorldInstanceContextService {
  open(sessionId: string): Promise<WorldInstanceContextView>;
  refreshIfStale(sessionId: string): Promise<WorldInstanceContextView>;
  invalidate(sessionId: string, reason: InvalidationReason): void;
}
interface WorldInstanceContextView {
  readonly sessionId: string;
  readonly sourceVersion: ContextSourceVersion;
  getPersona(): CharacterSnapshot;
  getMacros(): Readonly<Record<string,string>>;
  getHookCandidates(anchor: HookAnchor, phase: "before"|"after"): ReadonlyArray<LoreEntryIndex>;
  getCharacterCandidates(): ReadonlyArray<CharacterIndex>;
  getStateModuleCandidates(): ReadonlyArray<StateModuleDefinition>;
  getLoreOptions(): Readonly<SessionLoreOptions>;
  getCompiledStateDefinition(): CompiledStateDefinition; // 仅类型、无具体分支状态值
  getCompressedWorldline(): CompressedRunTopology;      // 可由拓扑服务委托读取
}
~~~

`AgentContext` 只读取上述资料，不改变世界实例；还从 Run/State 仓库拿当前父 Run 的**完整有效状态**。动态世界书命中、条件和模板都在 AgentContext 一轮内算，禁止 WorldInstanceContext 返回“上次调用激活的状态”作为真值。外部 UI 读取会话世界线与活动叶子通过 Session/Topology 服务 API，而不是访问内存实例指针。

## 7. 验收与延后

- 同一世界卡建立两局 Session，宏、手动世界书集合、当前叶子 Run 与状态快照互不干扰；进入/退出之后仍从数据库恢复。
- 更改 WorldBook 锚点/关键词/order 并显式同步世界实例，下一 AgentContext 查询结果按新索引排序；旧 FrozenView 不穿越提交。
- 状态类型树变更必须显式迁移；分叉切线不会把另一分支的值带入当前构建。
- 压缩拓扑缓存与从 Run 父链重建得到**相同 Root/Fork 节点和 collapsed_run_count**；普通/Branch Start/Leaf 全部不可见，但可从终止边的真实 leaf_run_id 进入路线。
- 禁止缓存执行后的 Prompt 文本为全局实例事实；Session 关闭释放缓存不丢失任何持久数据。

非目标：WorldInstanceContext 独立持久化第二份世界状态、后台持续轮询/事件驱动角色 Agent、跨设备分布式缓存、自动执行任意世界卡脚本和历史世界卡多版本混合加载。

相关：[World Card](world-card.md)、[AgentContext](agent-context.md)、[Session](session.md)、[Storage](../technical/storage.md)。
