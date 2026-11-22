# WorldStory 消息操作重构方案 V2

状态：**已确认产品边界，编辑与任意批删待实施；最新回复重生成已实现，不重做。** 本文替代旧的“删除此条及后续”和“重生成失败恢复旧回复”设计。这里的“正常叙事”指数据结构可读、可继续发送、符合资格时可补生成；不承诺修改前后的剧情因果一致，也不承诺绕过模型本身的失败或容量限制。

## 1. 产品契约

| 操作 | 用户选择与结果 | 明确不做 |
|---|---|---|
| 编辑正文 | 所有已保存的普通 user/assistant 消息，包括开场。只改原始正文，显示“已编辑”。 | 不重新调用模型、不改状态、不重跑旧后处理、不改写后续回复。 |
| 删除所选 | 从本会话任意位置勾选一条或多条已保存消息；可以跨轮、不连续、只选提问或只选回答。永久删除所选消息的完整 entry。 | **不提供按位置截断接口或按钮，不自动补选另一半或后续消息，不强制按轮选择。** 若用户手工选中整个尾部，仍只是按选中 ID 删除。 |
| 开场 | 会话中按 seq 最早的普通 message 是受保护首条（标准会话即初始化 assistant）。可编辑，不可删除。服务端按完整会话识别并返回 protectedMessageId；不是“当前分页第一条”，也不按 assistant 身份猜。空旧会话返回 null。 | 不能用批删、单选或自定义舞台绕过保护；不新增 opening 类型。 |
| 继续叙事 | 任意合法删除后均可提交新的用户输入；仅最新可见轮满足条件时可复用现有重生成/补生成。 | 不强迫先补齐缺失角色，不为补齐轮次伪造消息，不自动发起生成。 |

普通写操作只允许有权限、同步完成且没有活跃生成的会话。只读、翻页及停止生成的能力不受影响。用户接受文本与状态可能不同；平台仍对会话隔离、原子提交、写锁、合法链和继续叙事负责。

**例**：原顺序为 开场 → U1 → A1 → U2 → A2 → U3 → A3。勾选 A1、U2、A3 后保留 **开场 → U1 → A2 → U3**。A2 虽紧随 U1，仍是原来 U2 所属轮的回复，绝不重绑为 U1 的回复。下一次可以直接发送 U4，也可以对末轮 U3 补生成。勾选 U3 而保留 A3 时，A3 仍显示，可直接发送 U4，但不能对没有 U3 的 A3 重生成。

## 2. 交互

- **编辑文字**：消息菜单进入原位编辑，取 payload.message.content 而非渲染后的 HTML；保存/取消，支持 Escape、Ctrl/Cmd+Enter 和输入法组合。全空拒绝；相同正文不写库。提示“只修改文字，状态和后续回复不会重算”。保存失败保留草稿；同一消息已被删除则禁用保存，允许复制草稿。开场允许文字修订但不重做初始化。
- **多选**：菜单进入选择模式，按消息 ID 维护集合，支持加载更早分页再勾选；提供已选数量、取消和“删除所选 N 条”。桌面和手机都有可见入口，不依赖 hover。开场显示不可选原因；临时流式输出和隐藏摘要不可选。切换会话清空选择。
- **确认**：宿主弹窗显示本次确切选中条数及消息摘要，只计所选普通消息。说明“只删除选中消息；其他消息保留，不重算剧情。随消息保存的状态快照和用量记录也会移除。此操作不可撤销。”不把“状态一定不变”或“所有状态会回滚”写进提示。取消/失败不移除任何行；冲突需刷新后重新确认。删除后优先恢复至最近保留的可见消息，删除全部可删消息则聚焦开场。保留移动端焦点、滚动锚点和选择反馈。

## 3. 核心数据规则：删行而非重建对话

**物理删除单位是所选消息记录**，含 payload、state 快照、extData.output、metrics 等，不是只清正文或做软删除。未选消息的 ID、seq、runId、角色、内容、状态快照和计量均保留。仅允许维护必要的 parent、tip 和轮次终态元数据。

1. Server 进行会话访问检查。在同一同步事务内复查运行写锁、历史编辑版本、真实 tip、首条保护、所有目标属于同会话且为普通 message。空集合拒绝；重复 ID 去重；含首条、隐藏摘要、不存在或外会话 ID **整批拒绝，不部分成功、不泄漏其他会话信息**。采用显式上限（建议每次 200 个不同 ID，UI 同步限制，超限不自动拆成多次提交）。
2. 对包含 compaction 的实际 entries 按 seq 正序处理一次，取得保留序列。仅把受影响的保留行的 parent_id 指向最近的保留前驱；首个保留行 parent 为 null。删除选中行；tip 取最后一个**保留 entry**，不是最后一条可见聊天消息。尾部未受影响时 tip 不变。保留 seq 间隙，不给旧消息重排号；下一次 append 继续按既有 tip/seq 契约。单条重生成内部的 deleteEntry 不扩成任意公开删除接口，也不用循环调用它逐条提交/发事件。
3. 只清理悬空终态：若保留的轮首 entry 的 extData.narrative 指向本批已删回复，清掉该终态，保留其他 extData；未受影响的终态原样保留。若承载终态的轮首本身被删，不搬迁或重建其元数据；存活回复仍可读，缺少终态证据时沿用 unknown。普通发送不依赖上一轮为 completed。
4. 同事务写版本，得到真实 tip、精确删除 ID、受影响 runId 和有效 message 状态变化；失败全部回滚。提交后再发布事件。普通编辑只允许 message.content（原样保留有效文本的换行/空格）及服务端编辑标记；不以客户端完整 payload 覆盖 reasoning、tools、timestamp、state、output、metrics 或 outcome。editedAt 仅表示人工文字修订，不复用也会因改链更新的 updatedAt。

### 轮次、分页与摘要

**编辑与删除要区分两种“状态”。** `entry.state` 是剧情的消息状态快照；`entry.extData.narrative` 是整轮生成的结束结果，对应数据库 `entries.ext_data.narrative`。普通轮次 `U1 → A1` 的结束结果写在轮首 **U1**，不是 A1 自身的状态：记录 `status`（completed/stopped）、`finishedAt` 和本次执行预留的 `assistantEntryId`；stopped 另记 `stopReason`，不保证一定保存了回复。开场是例外：首条是受保护的 assistant，完成结果记录在它自身。

刷新历史时，正在执行的轮次从内存取 running/stopping；非活跃轮次只读轮首的结束结果，缺失时返回 unknown，不根据 AI 正文猜测。**编辑 U1 或 A1 的正文不改该结果**，也不把已停止的部分回复改成已完成。删除时只清理本批实际删掉的回复所对应的终态；不能因为某次停止本就没保存回复而误清其记录。只删 U1 时，终态随 U1 的整行删除，不复制到 A1。上述处理不重算剧情状态，也不是继续发送的前置条件。

| 删除后同轮剩余 | 展示及可用操作 |
|---|---|
| user + assistant | 仍按原 runId 展示；仅最新合法轮能重生成。 |
| 仅 user | 保留其真实输入；末轮可“生成回复”或直接发新输入，较早未回答消息不自动生成。 |
| 仅 assistant | 独立显示其正文和原处理记录；不猜所属提问，不能针对该孤立回答重生成；可以继续普通发送。 |
| 无普通消息 | 不展示空轮；隐藏 compaction 不得单独占一个分页名额、冒充最新轮或提供行动建议。 |

- **隐藏摘要不是批删目标**。保留其真实请求计量，不为删除某条可见消息而额外删摘要。已有 readSummary 校验覆盖终点、run 边界及正文 sourceHash：编辑/删除覆盖前缀时失效并回退到更早有效摘要或原文；未影响覆盖前缀的仍可复用。失效摘要不注入模型，不要求物理删除。如果要做彻底抹除历史内容，那是不同的隐私/数据清除需求，不以本操作代替。
- 当前 listEntryRuns 是按所有 entries 找轮次边界。须在 SQL 的**选轮阶段、limit 之前**排除无普通消息的 run；对选中有消息的 run 仍取完整保留 entries。正向补读、倒序游标、hasMore、最新可见轮和实际 tip 分别测试。不得客户端过滤完一页就误报“没有更多”。
- 当前 regenerate 用 user 后所有 entries 的 runId 判断末轮。删除后，真正末尾可能是其他已空轮的隐藏摘要：以**最后可见普通消息/轮次**判资格，仍独立校验真实 tip 和锁，允许无可见消息的旧轮留下摘要，不把历史中间回复放行。消息角色只看真实存活记录，不能按相邻位置“凑对”。
- 下一次普通 submit 仍在真实 tip 后保存新 user，prepareContext 仍只接收 sessionId 等原有输入；仅尾部新 user 移到 input.text，其余保留历史按真实角色和顺序传递。滑窗、摘要、最近两条 AI 旁注和关键词选择都从保留记录计算。覆盖连续 user、连续 assistant、只有开场、尾部只有 compaction 的候选与主请求编译。若某条已支持模型路由需要角色规整，只在该适配器按已验证要求处理请求副本，不补造库内消息、不把编译后的上下文静默改到超预算。

### 三个案例：哪些沿用现状，哪些需要适配

以下均假设批删已正确修复 parent 链和真实 tip。U 是用户消息，A 是 AI 回复，S 是不在聊天列表展示的摘要 entry。

1. **终态影响历史展示，不阻塞新发送。** 已完成的一轮为 `U1 → A1`，终态存在 U1 上。只删 A1 时，若不清理，历史仍会显示“已完成”并指向不存在的 A1；因此清理该引用。反过来，只删 U1 时，A1 保留原 runId 和正文，终态可为 unknown，不必迁移。两种情况都可以直接发送 U2；只有最新轮仍有 U1 且缺少回复时，才可对 U1 补生成。
2. **摘要在下一次构建 Prompt 时校验。** 编辑和删除只提交历史变更，保留已有摘要及其请求计量。下节按同一条时间线列出可复用的摘要，以及当前输入前实际保留的正文。
3. **尾部只剩隐藏摘要时，读取和追加各有依据。** 以下节删除 `U11、A11` 的案例为例，最后可见回复是 `A10`，真实 tip 是 `S5`。普通发送以 `S5` 为 parent 追加 `U12`。从同一删除结果另行测试重生成 `A10`：现有服务端会因它后面还有属于 `R11` 的摘要而拒绝，历史分页也可能返回空的 `R11`。批删后，分页与重生成资格应按可见消息判断，写入仍校验真实 tip。

### 滚动摘要案例：第 12 轮收到哪些历史

`R3` 代表第 3 轮的 `runId`。同轮的用户消息 `U3` 和 AI 回复 `A3` 各有独立的 `entryId`。下表括号内是会话写入顺序 `seq`，隐藏摘要也占一个序号。`S2`、`S5` 是两条摘要的示例 ID，数字表示**覆盖到第几轮**。每条摘要自身属于哪一轮，看它所在行的 `runId`。

| 轮次 | 按 seq 写入的记录 | 摘要覆盖的普通消息 |
|---|---|---|
| R0（开场） | A0(1) | |
| R1 | U1(2) → A1(3) | |
| R2 | U2(4) → A2(5) | |
| R3 | U3(6) → A3(7) | |
| R4～R7 | U4(8) → A4(9) → U5(10) → A5(11) → U6(12) → A6(13) → U7(14) → A7(15) | |
| R8 | U8(16) → **S2(17)** → A8(18) | 开场 A0 至 A2，`coveredThroughEntryId = A2` |
| R9～R10 | U9(19) → A9(20) → U10(21) → A10(22) | |
| R11 | U11(23) → **S5(24)** → A11(25) | 开场 A0 至 A5，`coveredThroughEntryId = A5` |
| R12（待回答） | U12（原时间线为 seq 26） | 当前输入 |

下列操作都发生在发送 U12 **之前**，每行从同一份原始历史独立开始。表中仅展开 Prompt 的摘要、历史正文和当前输入，假设拼接后在预算内。`U4…A11` 等区间表示按原 seq 读取区间内存活的普通消息正文。各行最后的 U12 进入 `input.text`，只出现一次。

| 编辑或删除操作 | 下次构建时如何选摘要 | 第 12 轮上下文顺序 |
|---|---|---|
| 编辑 A3(7) 的正文 | S5 的终点 A5 仍在，但覆盖前缀的正文指纹已变。S2 覆盖到 A2，仍有效。 | S2 → U3 → **新版 A3** → U4…A11 → U12 |
| 只删除 A3(7)，保留 U3(6) | S5 覆盖的消息少了 A3，指纹失配，使用 S2。 | S2 → **U3 → U4** → A4…A11 → U12。相邻的两条用户消息分别属于 R3、R4。 |
| 只删除 A5(11)，保留 U5(10) | S5 的覆盖终点 A5 已删除，直接跳过 S5，使用 S2。 | S2 → U3 → A3 → U4 → A4 → **U5 → U6** → A6…A11 → U12 |
| 同批删除 U11(23)、A11(25) | R11 只剩 S5(24)。它覆盖的 A0 至 A5 全部保留且正文一致，仍可使用 S5。 | S5 → U6…A10 → U12。R11 没有正文进入历史，新输入追加在 S5 后。 |
| 编辑开场 A0(1) | S2 和 S5 都覆盖开场，两条摘要的指纹均失配。 | **新版 A0** → U1…A11 → U12。若原文超预算，按现有滚动策略尝试生成新摘要。 |

第一行回退到 S2 后，摘要覆盖范围从第 0～5 轮缩短到第 0～2 轮，第 3～5 轮重新以正文进入上下文，模型能读到修改后的 A3。若只改第 6 轮，S5 仍可复用，修改后的第 6 轮正文直接接在 S5 后面。

## 4. 状态、建议和用量

| 数据 | 编辑正文 | 任意批删 |
|---|---|---|
| message 状态 | 不写入、不重算。 | 读取新真实 tip 的最近非空快照。保留的显式快照继续生效；若删掉之前唯一的快照，后继可能改为继承更早值，**即使 tip ID 没变**。按前后有效值比较，变化才发既有 state.changed 全 scope 替换。 |
| session/global 状态 | 均不变。 | 均不回退；不重放、反向执行历史 state_update。 |
| 建议与旁注 | 保留原输出；只修订正文。 | 不显示已删 AI 的建议或旁注。按最后保留可见轮及其真实回复恢复建议；最新只剩 user 或仅开场无建议时清空。不重新生成建议。 |
| 会话累计 | 保留 metrics，数额不变。 | 延续当前“现存 entries.metrics 求和”：被删行不再计入，保留摘要仍计入；不新建账本，不代表供应商退款。 |
| 上下文用量 | 请求快照仍描述当时实际发送内容，不以改后正文重算。 | 最近有记录的存活 AI 请求仍是 latestContext 来源；被删则读上一条或空。不以重生成/删除前的缓存冒充当前统计。 |

## 5. 接口、并发与同步

**推荐最小新增版本：historyEditRevision。** sessions 增加非空整数，旧库迁移为 0；定义为“既有历史被人工编辑/批删的代数”，不是 seq、不是每个流事件的计数。每次实际人工变更原子 +1（一次批删只加一次）。既有追加、重生成继续使用真实 tip、执行 ID 和删除回执；不要求重做普通发送/停止协议。两个窗口编辑不同消息也可能冲突：接受这个保守取舍，不实现自动合并。所有外部可改已存正文的入口必须经过同一写路径；不能保留旁路。

| 建议接口（均位于现有会话路由下） | 输入 | 返回 |
|---|---|---|
| PATCH /sessions/:id/messages/:messageId/content | content、expectedTipEntryId、expectedHistoryEditRevision | 编辑后的消息/editedAt、真实 tip、版本；同值不新增标记/事件。 |
| POST /sessions/:id/messages/delete-selected | messageIds[]、expectedTipEntryId、expectedHistoryEditRevision | 唯一的 deletedMessageIds、affectedRunIds、真实 tipEntryId、historyEditRevision。只有按 ID 精确删除，无 delete-from 或范围预览接口。 |
| 读取：session 详情 / narrative/runs | 沿用现有读取 | 提供同一快照的版本、protectedMessageId、真实 tip，用于保护/对账；历史页返回其读取版本，不能把独立查询的新版本贴在旧页上。 |

- 访问检查复用现有 session access；非法目标/保护首条、版本冲突、运行写锁给出可识别错误，锁/版本冲突返回 409。SDK 不接收任意 sessionId、seq、payload、state 或 metrics。既有通用 entry PATCH 不得绕过版本：含正文修改必须通过同一用例、携带预期版本、禁止混合修改受保护字段；非正文旧用途逐项核对并保留合法能力。任何能替换 message payload 从而改正文的路径一并拦截，通用 extData 不得伪造或擦除 editedAt。
- HTTP 回执与新会话 SSE `history.changed` 表达**已提交**的人工操作，含 sessionId、kind、版本、tip、变更 ID 和相关轮次，不广播草稿、正文副本或完整状态。避免为一次人工删除逐条伪造重生成专用 message.deleted（它携带 assistantEntryId）。失败/取消不发事件；删除导致有效状态变化时继续发独立 state.changed。SSE 不保证一定送达。
- 编辑草稿/批选在开始时绑定当时的基准版本与 tip；宿主不能悄悄用“最新版本”提交旧草稿。WorldStory 通过 SDK 提交意图；Web 宿主用其**已同步的持久记录**核对 ID、生成确认摘要，未知/未加载目标先同步或拒绝，不根据作者传来的标题或计数代为确认。HTTP 和 SSE 任一先到均按版本幂等。冲突时保留可恢复草稿，不盲目重试删除；旧确认作废。
- 历史控制器收到人工变更：立即失效旧读请求/缓存分页，按 ID 更新或移除已知记录，重读最近有界历史并确认真实 tip/版本；有历史锚点时按需重载原页，锚点已删则定位最近保留项。切换 session、断线重连和显式同步都重取基准，不依赖 afterSeq 发现原地编辑/中段删除。重连期间禁写，过期响应不得把旧内容加回来。同步建议、实际状态和用量面板；不要把 SSE 数值二次加总。
- 新增窄命令 `messages.editContent`、`messages.requestDeleteSelected`；需要确认的操作统一由 Web 宿主决定是否发送 HTTP。StageSnapshot 下发保护 ID、版本及已保存消息的 editedAt；作者预览不获运行权限。平台责任边界不变：WorldStory 管草稿/选择，workspace 编排，history 管已存历史，stage-host 只管桥接。

## 6. 计划变更目录（相对仓库根；非本轮已实施文件）

~~~text
仓库根/
├── AGENTS.md、apps/{server,web}/AGENTS.md                [改] 人工历史操作、同步及职责
├── apps/server/src/
│   ├── infrastructure/database/{connection,connection.test}.ts [改] 新库/已有 V2 迁移、结构检查
│   ├── modules/sessions/{types,schema,service,repository}.ts [改] 版本、保护首条、精确改字/批删、轮次分页及终态
│   ├── modules/sessions/service.test.ts                  [改] 原子性、跨会话、残轮、计量
│   ├── usecases/message-operations{,.test}.ts            [增] 校验、事务、状态比较、提交后事件
│   ├── usecases/narrative/{regenerate,regenerate.test}.ts [改] 最新可见轮与真实 tip 分离
│   ├── usecases/context/{context,prepare}.test.ts         [改] 保留历史、摘要、裁剪和连续角色验证
│   ├── infrastructure/pi/client.test.ts                  [改] 已支持路由的保留消息顺序测试
│   ├── usecases.ts、app.ts、errors.ts                    [改] 装配、路由、错误
│   ├── routes/{sessions,narrative}.ts                    [改] 基准读取、窄写接口、通用 PATCH 收口
│   ├── routes/{sessions-state,narrative}.test.ts          [改] 访问、契约与冲突
│   └── infrastructure/events/{session-events,session-events.test}.ts [改] 类型化会话事件
├── apps/web/src/
│   ├── features/history/controller.ts                    [改] 人工版本、分页失效和同步
│   ├── features/sessions/message-operations.ts            [增] 调用、基准检查、确认生命周期
│   ├── features/sessions/MessageDeleteDialog.tsx          [增] 宿主删除确认
│   ├── features/sessions/{workspace,SessionPage,client,types}.ts(x) [改] 意图编排、快照与刷新
│   ├── stage-host/commands.ts、transport/session-events.ts [改] 窄命令和新原生事件透传
│   └── features/suggestions/controller.ts                [按需改] 残缺轮次的建议恢复
├── apps/web/tests/{history,session-workspace,stage-host,session-events,suggestions}.test.mjs [改] 竞态与恢复
├── packages/sr-sdk/src/
│   ├── stage-contract.ts、stage/{runtime,index}.ts(x)    [改] 接口、回执、快照、类型导出
│   ├── stage/world-story.tsx、world-story.css            [改] 消息入口、选择与阅读位置
│   └── stage/message-actions.tsx                         [增] 正文草稿、多选操作栏
├── docs/runtime/{server-http,server-events,server-narrative,web-runtime}.md [改] 已实现后更新实际契约
└── docs/design/{UI-SPEC,world-components}.md             [改] 已实现后写交互与组件边界
~~~

无计划删除的源文件，无 runs 表、请求账本、通用 setTip、分支、回收站或后台重演服务。实现中若函数级验证发现特定模型适配不接受合法历史，仅对证实的适配做最小修正并补测，不改变状态或记录模型。执行顺序与发布门槛见同目录《WorldStory-消息操作任务》。
