# Session：Run 树、消息归属、分页与压缩世界线

> 2026-11-03 目标设计，**尚未实现**。本文件把过去的 Entry 树改为 **Run 树 + Run 内 Message**。分页、分叉、世界线统计、活动叶子和缓存 revision 以 **Run** 为唯一单位，不再使用 Message/Entry 当树节点。数据持久化细则见 [Storage](../technical/storage.md)。

## 1. 核心产品模型

`WorldCard` 是可重复使用的世界定义；`Session` 是一次独立的世界实例及其故事树；`Run` 是该故事树上一次完整的互动回合；`Message` 是某个 Run 内要展示的用户或模型消息。一次普通 Run 通常包含一条 User Message 和一条 Assistant Message，Opening Root Run 是特例，仅含初始 Assistant/Opening Message。模型内部工具消息、思维过程、SSE event 等不构成玩家可见 Message，也不额外创建 Run。

~~~text
Session (World Instance)
└─ Run R0 (opening)  [Message: assistant 开局；初始状态 S0]
   └─ Run R1 (turn) [Message: user U1, assistant A1；状态 S1]
      ├─ Run R2 (turn) [U2,A2；状态 S2]    路线 A
      │  └─ Run R4 [U4,A4]
      └─ Run R3 (turn) [U3,A3；状态 S3]    路线 B
~~~

**重要约束：**
- Run 的 `parent_run_id` 指向同一 Session 的父 Run，Root 的 parent 为 null；**Message 只有 `run_id` 和顺序，不参与 Run 树父子关系**。
- 单个父 Run 最多 **3 个直接子 Run**，表示至多 3 条后续选择；允许多级嵌套分叉，整棵世界线叶子总数没有 3 的限制。
- 正常发送只能在 `sessions.active_leaf_run_id` 指向的真实叶子继续；用户从历史 Run 显式发起新分叉时，必须在有足额空位的父 Run 下新增兄弟 Run。
- `seq` 可记录 Session 内创建顺序，但不得用全局 seq 推导祖先、分页顺序或隐藏 Run 数；唯一合法祖先关系是 `parent_run_id`。
- 开局选中 `user_character_id` 来自世界卡/Opening 的可扮演名单，保存角色快照和完整强类型状态 Schema；不同 Session 彼此隔离。

## 2. Run / Message 生命周期

`Run` 核心字段：`id, session_id, parent_run_id, kind(opening|turn), status(awaiting_ai|completed), seq, state_snapshot_json, state_status, state_schema_hash, state_revision, generation_id, created_at, updated_at`。`Message` 字段：`id, run_id, ordinal, role(user|assistant), content, raw_content?, revision, created_at, updated_at`。状态变化属于 Run，模型回复归属 Run 的 Assistant Message。Opening Run 只有 ordinal=0 的 assistant Message；普通 Run 最多 ordinal=0 user、ordinal=1 assistant。未来如果支持多段可见消息须显式扩展，不自动把工具回合算作玩家回合。

~~~mermaid
flowchart LR
 A[活动完整 Run 叶子] --> B[提交用户文本]
 B --> C[短事务: 新建 child Run status=awaiting_ai + User Message + 继承父快照]
 C --> D[AgentContext 构建 Messages + Provider 执行]
 D -->|成功| E[同一 Run 添加 Assistant Message + ChangeSet/完整状态 + status=completed]
 D -->|取消或错误| F[Run 保持 awaiting_ai, User Message 已保存]
 F -->|用户重试| D
~~~

- 创建 Run 与第一条 User Message 使用一次短事务、幂等客户端 request ID 防重复；同时更新 `active_leaf_run_id`。AI 生成期间不写占位 Assistant Message、不持有长事务。失败/取消保留同一 Run 供显式重试，不另建 Run、更不制造假分支。
- 成功后一次事务提交清洗正文与 Raw、状态变更集、有效全量快照、Run 修订和 Assistant Message；`completed` 不等于状态一定有效，状态层可独立标记 `missing/invalid`，后续须修复或确认继承才能继续。
- 如果还未收到 AI，`awaiting_ai` 的 Run 仍是合法真实**叶子 Run**；UI 显示用户文本和“重试生成”入口。重复生成响应必须绑定同一 generation ID 和父 Run/状态版本，避免再次 `adjust`。
- 末尾 Assistant 重新生成/续写（未来功能）只重写**本 Run 的 Assistant Message**和状态结算，不新建 Run；若该 Run 已有子 Run，不允许无提示重写历史因果，可先走明确历史修复流程。
- 编辑任意历史 User/Assistant Message 保留原有 Run 树和消息，不自动改写后代；该 Run 及其后代的状态与依赖摘要标记 `stale`，不能自动把旧有效快照作为新事实继续生成。
- 只有完整有效的父 Run 才可被用作新 Run 的状态来源。用户说出行动不等于行动已经发生：User Message 创建时复制父快照，AI 成功解释剧情之后才应用本轮 ChangeSet。

## 3. 聊天：以 Run 为分页单元

进入 Session 读取 `active_leaf_run_id` 指向的真实叶子，默认取最近 **30 个 Run**（不是 30 条 Message），返回每个 Run 内完整可见 Messages，按 Run 旧→新/Run 内 ordinal 升序展示。向上滚动只读取更老的**祖先 Run**；不存在双向窗口或中间历史定位。不同 Run 包含不同数量消息，页面一次返回的可见 Message 数不固定，这是刻意选择。

~~~http
GET /sessions/{sessionId}/runs?limit=30
GET /sessions/{sessionId}/runs?leaf_run_id=R900&before_run_id=R850&limit=30
~~~

响应：

~~~json
{
  "leaf_run_id": "R900",
  "runs": [
    {"id":"R899","parent_run_id":"R898","status":"completed","messages":[{"role":"user","content":"我进城"},{"role":"assistant","content":"守卫让开道路"}]},
    {"id":"R900","parent_run_id":"R899","status":"awaiting_ai","messages":[{"role":"user","content":"继续向前"}]}
  ],
  "next_before_run_id":"R899",
  "has_more":true
}
~~~

`before_run_id` 为当前列表最早 Run ID，严格从它的父 Run 继续，不能重复返回当前 Run；服务端校验 `leaf_run_id` 是当前活动真实叶子、`before_run_id` 是其有效祖先且属于同一 Session。请求应在同一一致性读取视图中取得 Run 页和其 Message，避免 Chat 页出现半个 Run。返回 `limit+1` 个祖先 Run 判定是否有更多，展示最多 limit 个。跨世界线切换清空旧列表/游标、废弃旧请求；同线新增 Run 可以追加并更新 leaf 绑定，保留正在阅读的祖先页面和视觉锚点。前端虚拟化以 Run 分组为稳定锚点。

**模型 Context 不能只读取 UI 的最近 30 个 Run**。AgentContext 可单独按 Run 父链读取真实祖先，再按 Token 预算用 Run 作为最小历史裁剪单元；Chat 阅读页数不影响模型召回历史。

## 4. 压缩世界线：只显示 Root 和 Fork

**全局世界线不再绘制 Branch Start 和 Leaf 节点。** 可见节点只有：
- `root`：Opening Run；
- `fork`：拥有 2～3 个直接 Run 子节点的真实 Run；Root 也可能同时是 Fork。

其余普通、分支起点、叶子 Run 全部压在**连接线**上。每一条从 Root/Fork 出发的线延伸至**下一个 Fork 或终止**；边携带：
- `from_run_id`：可见的起始 Root/Fork；
- `to_fork_run_id?`：下一真实 Fork，若该路线走到终点则为 null；
- `branch_start_run_id`：起始节点的该分支第一个子 Run（不单独画节点）；
- `collapsed_run_count`：该段所有未画出来的真实 Run 数；**终止边把不可见 Leaf Run 也计入**，而中间通往可见 Fork 的边不计起终两端可见 Run；
- `terminal_leaf_run_id?`：终止边实际叶子 Run，用于点击“进入此路线”；
- `branch_preview?`：起点附近的简短 User 输入摘要，作为线标签，而非新节点。

普通线性故事：Root → 一条带“已折叠 N 个 Run”的**终止线**，可通过其 `terminal_leaf_run_id` 进入；没有显式 Leaf 圆点。只有 Root 没有子 Run 时仅显示 Root，它同时可作为终点。若中途产生历史分叉，则提升真实 Fork 节点并拆线重算折叠数。

~~~mermaid
flowchart LR
 Root[Root Run R0] -->|折叠 8 个 Run| Fork1{Fork Run R9}
 Fork1 -->|路线 A：折叠 12 个 Run| EndA[终止线端点，非实际 Run 节点]
 Fork1 -->|路线 B：折叠 5 个 Run| Fork2{Fork Run R15}
 Fork2 -->|折叠 3 个 Run| EndB[终止线端点，非实际 Run 节点]
 Fork2 -->|折叠 7 个 Run| EndC[终止线端点，非实际 Run 节点]
~~~

图中的 `EndA/EndB/EndC` **只是为 Mermaid 说明终止线而写的图形端点，不属于 API 可见节点**；客户端不画它们为可选 Run。实际 API 在边上返回 `terminal_leaf_run_id`，线卡片可点。预览选择某条路线只是临时高亮 `selected_leaf_run_id`；必须点击“进入”才更新持久化 `active_leaf_run_id` 并重新加载 Chat 页。不能凭 seq 猜终点，更不能把中间 Fork 当成聊天可进入叶子。

接口建议：

~~~http
GET /sessions/{sessionId}/worldlines
PUT /sessions/{sessionId}/active-leaf
Content-Type: application/json

{"leaf_run_id":"R900","expected_active_leaf_run_id":"R700"}
~~~

世界线接口只加载 Run 的轻量父指针/子数/简短预览等元信息；**不拉取全部 Message 正文**。`collapsed_run_count` 基于真实父链逐个 Run 计算，不是全局 seq 差，不是 Message 数。返回 `run_tree_revision` 和 `run_content_revision` 作为缓存一致性标记。大树支持可展开子树与 `has_more`，不能未经说明截断成“完整拓扑”。

## 5. 分叉与角色

当用户在历史 Run R2 的 User Message 上选择“从这里创建另一种行动”，语义是：**把新 Run 挂到 R2.parent_run_id 作为 R2 的兄弟**（从同一个历史决策点重选），而不是把新 Run 接到 R2 或 R2 的 Assistant 后面。校验历史 R2 非 Root、其父 Run 已完成且状态可用、父 Run 子数小于 3；新分支继承**父 Run 结算状态**、读取该父 Run 的祖先消息，不混入 R2 的 User/Assistant。第三条分支允许，第四条拒绝。只有显式提交新分叉才自动切入该新 Run，不因世界线“预览”而切换。

Session 的 `user_character_id` 从世界卡 `characters[]` 中受 `player_selectable` 和 Opening `player_characters` 共同许可的 ID 明确选择，用户身份快照保存在 Session；同一 Session 不为每条 Run 再随意覆盖用户身份。`{{user}}` 的取值由 WorldInstanceContext 查询本局角色快照。

## 6. 对外领域接口与权威数据

Session 领域建议：`createSession(worldId, openingId, userCharacterId, presetId, modelSelection)`、`getSession(id)`、`getRunPage(sessionId, leafId, beforeRunId, limit)`、`getRunAncestorPath(runId)`、`appendUserRun(sessionId, expectedLeafId, requestId, input)`、`completeRun(runId, generationId, assistantText, changeSet, stateResult)`、`retryRun(runId)`、`forkRun(sessionId, historicalRunId, newUserText)`、`editMessage(messageId, expectedRevision, content)`、`getCompressedWorldlines(sessionId)`、`switchActiveLeaf(sessionId, expectedLeafId, newLeafId)`。这些接口只处理**Run/Message/Session 持久化与一致性**，不在 Session 内写 Prompt NodeBuilder。

WorldInstanceContext 在实例进入时恢复世界卡/身份/结构缓存；AgentContext 按本轮父 Run 读取状态和祖先 Runs；Provider 只拿 Messages 做模型执行。`sessions.active_leaf_run_id` 为唯一持久化活动叶子；模型执行始终绑定请求创建时的 Run ID、父版本、Schema 版本，迟到响应不能在切线后覆盖另一条路线。

## 7. 缓存与一致性

`run_tree_revision` 在新增子 Run、子节点关系变化时递增，`run_content_revision` 在 Run 结算、状态徽标/预览内容变化或 Message 修改时递增。拓扑结构可按前者增量维护，预览缓存同时绑定后者。世界线缓存可按新 Run 做增量更新：
- 单链尾部追加只更新终止线 `terminal_leaf_run_id` 和 `collapsed_run_count +1`；
- 某历史 Run 从一个子 Run 变为两个时，**提升该 Run 为 Fork**，拆原来线段并分出两条边，重新计算涉及路径；
- 编辑消息只使相应边标签/Preview 失效、状态与下游上下文 stale，**Run 树结构不变**；
- 切活动叶子只改变选中高亮，不改变压缩拓扑。

MVP 可优先每次按整个轻量 Run 元数据重建拓扑，避免复杂增量算法先污染正确性；以后用 revision-key 的增量缓存加速，必须和确定性全重建的结果对拍。缓存只在 [WorldInstanceContext](world-instance-context.md) 管理，不写第二份树的持久化事实。

## 8. 验收与不支持范围

- Root 只有一条 Opening Assistant Message；普通 Run 的 User/Assistant 被完整打包返回；`limit=30` 表示 30 Run，不能拆断 Run。
- Run 与 Message 的关系不会使模型历史重复插入当前 User；未完成 Run 可重试，重复请求不生成无意分叉或重复扣灵力。
- 拓扑**只显示 Root/Fork**；分支起点、普通 Run 和叶子都只占边的准确 `collapsed_run_count`，可通过真实 `terminal_leaf_run_id` 进入终点。
- 深分叉、没有任何分叉、Root 也是 Leaf、历史分叉超 3 限额、错误游标、异常父链、不同 Session 隔离均需验收。
- 历史编辑不重生成后代或静默提交失败状态；模型失败、网络断开和服务重启不丢已保存用户 Run。
- 不支持任意 Run 中间阅读模式、双向历史窗口、Run/Message 删除、跨设备阅读位置、自动推导虚构分叉。

相关：[AgentContext](agent-context.md)、[WorldInstanceContext](world-instance-context.md)、[Storage](../technical/storage.md)、[State](state.md)。
