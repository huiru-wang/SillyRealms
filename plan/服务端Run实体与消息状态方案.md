# 首发 Server 轮次、消息状态与结算契约

## 决策与交付边界

建议先改 Server，再以实际通过测试的 HTTP / SSE 契约修订前端重构方案。单修 SDK 也能恢复已存在的状态和 21 个停止原因。引入 Run 的理由是 SR 已经需要独立查询和更新“一轮”：同一条用户输入可以多次生成，失败时可能连助手消息都没有，摘要可以成功而本轮回复失败。一轮应有稳定的身份、顺序和可回读的结论。

这一期增加一张 `runs` 表。消息本身的完整性、整轮的执行结果和模型对世界状态的修改分开建模。沿用 SQLite、Session 模块、现有同步事务、会话写许可和会话 SSE。首发使用新数据根。实施和验收顺序见[任务清单](服务端Run实体与消息状态任务.md)。

## 现状与证据

| 已核实的实现 | 对重构的影响 |
| --- | --- |
| SQLite v14 的 entries 已有 run_id、seq、parent_id、state、ext_data、metrics_json。分页先用首尾 seq 从条目中选轮，再取该轮全部条目。[建表](../apps/server/src/infrastructure/database/connection.ts) · [查询](../apps/server/src/modules/sessions/repository.ts) | 同一轮执行状态改变时可能没有新 seq；再生还可能删除或复用尾部 seq。用轮自身的排序键翻页。 |
| 查询先读内存 active，再读首条 entry 的 extData.narrative，否则返回 unknown。Server 的历史页已能返回 status、stopReason；SSE 的 run.stopped 有原始 stop_reason。前端拟议 Run 和三类 reason 在投影时损失信息。[历史查询](../apps/server/src/usecases/narrative/index.ts) · [事件](../apps/server/src/usecases/narrative/events.ts) · [前端拟议契约](首发舞台SDK契约与用例.md) | Server 的新契约给出两种状态和一个停止原因枚举，可用同一组样例检验历史和事件。 |
| 当前正常收尾先提交助手、entries.state 和 extData.output，随后另写用户条目的 outcome；中断时可能只存部分助手，也可能只保留用户。run.delta 最终 snapshot 先于这两次写入。[结算](../apps/server/src/usecases/narrative/execute.ts) | 最后一次模型输出不能证明成功。一次终态事务需要覆盖消息、状态效果、解析结果、主请求计量和轮次结论。 |
| 开场已经有 runId、已保存的助手、初始化结果；再生沿用 user 和 runId，预留新的 assistantEntryId；用量查询目前按存活条目的请求记录统计。[开场](../apps/server/src/usecases/create-session.ts) · [再生](../apps/server/src/usecases/narrative/regenerate.ts) · [用量](../apps/server/src/modules/sessions/service.ts) | 开场也占一轮。轮身份和执行身份应分别表达，按轮计量时须明确替换和摘要的口径。 |
| compaction 写入 parentId = tip.id、runId = tip.runId，有自己的正文、coverage、hash 和摘要请求 metrics。[摘要提交](../apps/server/src/usecases/context/prepare.ts) · [复用校验](../apps/server/src/usecases/context/stages/compact/saved-summary.ts) | 摘要已经属于某轮。其覆盖的历史和其归属轮是两件事。 |

## 谁对什么负责

| 概念 | 唯一拥有的数据与行为 |
| --- | --- |
| Session | 世界、设置、本地状态、当前 tip。一次会话容纳多个有序 Run。tip 指向条目，可能是摘要；发送、再生时仍校验它。 |
| Run | 会话内的一轮。拥有当前执行身份、运行状态、精确停止原因、该次执行的能力结果以及轮次用量。重新生成替换此轮的回复。 |
| Execution | 每次受理时预留的 assistantEntryId 就是执行身份；可能永久没有同 ID 的消息行。已有 runId + assistantEntryId 足以隔离迟到回调。首发无独立 attempts 表和旧回复版本库。 |
| Message entry | 保存一条用户或助手内容及其完整性。正文、思考文本、已有工具快照、角色、时间、父链和消息级状态值归此条目。 |
| Compaction entry | 内部模型上下文条目。保存摘要、覆盖边界、来源 hash 和在父链的位置。摘要请求计入其所属 Run。 |
| Narrative / Context / State | Narrative 编排受理、调用、停止和结算。Context 捕获实际 tip 并决定摘要，State 计算授权路径与生效值。Session 模块负责同一数据库内的 Run/entry 不变量。 |
| 内存与 SSE | 内存持有运行控制器、写许可和生成过程中的临时输出。SSE 传分片和已提交变化。断线后从 Run 读权威结果。无逐 token 写库、无事件回放；中途重载仍可能缺少此前正文或思考前缀，需等最终 snapshot 或终态回读。 |

## 数据模型与约束

下列为建议的 SQLite 核心 DDL。page_key 由数据库分配，外部标识仍是 id。现有表的外键保持原状，新表及 entries.run_id 均不声明 FK。

```sql
CREATE TABLE runs (
  page_key INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  assistant_entry_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('running','stopping','completed','stopped')),
  stop_reason TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(capabilities_json) AND json_type(capabilities_json) = 'object'),
  metrics_json TEXT NOT NULL DEFAULT '{"main":null,"summaries":{}}'
    CHECK (json_valid(metrics_json) AND json_type(metrics_json) = 'object'),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  CHECK ((status IN ('running','stopping') AND finished_at IS NULL AND stop_reason IS NULL)
      OR (status = 'completed' AND finished_at IS NOT NULL AND stop_reason IS NULL)
      OR (status = 'stopped' AND finished_at IS NOT NULL AND stop_reason IS NOT NULL))
);
CREATE INDEX idx_runs_session_page ON runs(session_id, page_key DESC);
CREATE UNIQUE INDEX idx_runs_session_active ON runs(session_id)
  WHERE status IN ('running','stopping');
```

- `entries` 增加原子列 `status`。message 必填 `complete | partial`，user 只能 complete；compaction 必须 NULL。用显式 IS NOT NULL 和 type/role 联合 CHECK，防止 SQLite 将 NULL 谓词当作通过。完整性只描述已保存内容。排队、生成中、停止中都是轮次状态，无需建空助手行。失败的用户提交在受理事务回滚后没有消息。
- 保留 `entries.run_id`、`UNIQUE(session_id,seq)` 和 `(session_id,run_id,seq)` 索引。每次追加都在同一事务校验 session、run、tip 和角色；助手 ID 须等于本轮预留值，用户只在受理时追加，开场只有助手。compaction 继承真实 tip 的 runId，写入路径校验同会话。不通过通用 entry 编辑接口修改轮归属、消息状态、计量和能力结果。
- 删除 entries.metrics_json 以及 ext_data.narrative / ext_data.output 的读写。ext_data.summary 继续服务于摘要。停止原因仅在 runs.stop_reason 写一次，使用 Server 枚举校验写入与解码。Run 不重复存 messageIds、正文、父链或有效世界状态。
- 无新 FK 的配套要求是所有涉及两表的写入都走 Session 模块的受控事务。删除会话先执行既有写锁校验，再在同一事务显式删除该会话 runs 和 session，由既有规则清理 entries。删除世界复用同一入口，任一失败整体回滚。正常操作期间活跃会话不能被删除。完整性测试覆盖孤儿 Run、孤儿条目、跨会话引用和错误执行身份，查不到 owner 视为数据错误。
- 新空库版本 v15，保留 application_id 与旧库拒绝启动策略。v14 及更旧数据不迁移、不覆盖。上线需新数据根；旧根和匹配的旧服务版本成对保留以供回退。

建议将下列 CHECK 放入 v15 的 entries 建表定义，与既有 type/role 及 payload 检查一同生效。

```sql
CHECK (
  (type = 'compaction' AND role IS NULL AND status IS NULL) OR
  (type = 'message' AND role IS NOT NULL AND status IS NOT NULL AND (
    (role = 'user' AND status = 'complete') OR
    (role = 'assistant' AND status IN ('complete','partial'))
  ))
)
```

### 状态判定样例

| 可观察情况 | Run.status / stopReason | 已保存消息 |
| --- | --- | --- |
| 开场或正常回复完成 | completed / null | 开场仅 assistant complete；普通轮 user complete、assistant complete |
| 输入已提交，仍在摘要或生成 | running / null | user complete；用 assistantEntryId 跟随后续事件 |
| 已接受停止请求，等待结算 | stopping / null | 用户消息仍 complete |
| 模型在输出正文后碰到长度上限 | stopped / output_limit_reached | user complete、assistant partial，保留可见输出 |
| 只有思考文本后被取消 | stopped / cancelled | user complete、assistant partial，思考文本可以回读 |
| 凭据缺失或取消时尚无可见输出 | stopped / credential_not_configured 或 cancelled | 只有 user complete；预留 ID 仍可识别执行 |
| 正文成功且立绘部分无效 | completed / null | assistant complete；失败行见 Run 能力结果 |
| 主输出提交失败，最小失败结算成功 | stopped / message_persist_failed | 已提交的 user 与可能已有的 compaction 保留 |

`complete` 表示这条消息已完整形成，`completed` 表示本次轮次已成功结算。即使 Run 停止，也不能把已成功保存的用户消息标为失败。流中已有字节却未能提交时，查询只列实际保存的消息。

### 扩展能力、状态值与计量

**一个扩展字段。** `runs.capabilities_json` 以能力名为键。首发为 `stateUpdate`（status、逐行 updates、errors）、`actionSuggestions` 和 `characterSprite`（status、items、errors）。沿用各自的输出校验、部分成功和读取损坏数据的降级。未执行后处理的轮为 {}；正常执行时按现有 parser 的实际产出写入，缺少立绘标签省略该键，显式清空为 success + []。错误结果保留诊断，单项错误不覆盖其他项。新增能力只需扩展对应处理、校验、读模型与必要事件。DB 不按能力增列，不引入通用插件注册平台。会话功能开关仍归配置，不能以是否出现输出判断开启与否。

**状态更新与状态值。** 例如解析出一项“好感度 +1”，本轮的 `stateUpdate.updates` 保存路径、结果值及成功或失败原因。实际可读值走既有 State 模块，message scope 的有效快照仍由 entries.state 及其继承规则决定。再生删除旧助手后按新 tip 计算有效视图并发出实际变化。读取历史或重建提示词均不重放操作；global、session 和手工状态写入保持各自所有权。

**立绘资源。** 让 Server 对模型返回的角色、姿势和位置做现有目录校验，再将本次捕获目录内的 `asset` 资源引用与有效 item 一起写入能力字段；HTTP 与 SSE 读取同一组已验证值。模型输入和历史 notes 仍只投影语义字段。该引用延续现行资源访问规则，持久化路径不保证旧文件永久可下载。最新一轮没有立绘输出就没有该轮立绘，禁止向前寻找最近一次非空输出。行动建议遵循当前执行的所有权。

**轮次用量。** `runs.metrics_json` 存固定计量事实，与可扩展能力独立。结构为 `{ main: RequestMetrics | null, summaries: Record<compactionEntryId, RequestMetrics> }`，RequestMetrics 复用既有 requests 列表与可选主请求 context 快照（关联 requestId、provider、model、窗口、字节构成、时延）。以 requestId 去重；采用当前执行身份防止旧回调写回。摘要写入与其计量同事务；结算只替换 main，绝不以受理时的旧 JSON 覆盖后来写入的 summaries。跨摘要和主请求校验重复 requestId，不额外持久化总数。

- 无主请求为 main=null。已实际发起且获得请求记录的主调用，即便没有可保存的助手，也记录已知计量；已发起但 token 未知用 usage=null。进程硬退出只保留已经提交的事实。摘要保持现有口径，仅成功提交的摘要计量；若已保存请求但未获 token，仍计一次未知。独立帮答不进入叙事轮用量。
- `Run.usage` 从整轮保留的 main 和所有 summaries 得出 knownUsage（input/output/total/cacheRead/cacheWrite）、recordedRequestCount、unknownUsageRequestCount。未知不按零推断；缓存命中是 input 的分项。会话用量按同一逻辑汇总。重生成替换旧 main，保留已有摘要，适用于当前保留轮次的统计；它不能作提供商累计账单。最新上下文仍选最近有持久助手且有主请求快照或指标的轮，沿用 requestId、模型配置与 tip 的 stale 判断，摘要不能冒充主请求。
- 新 `run.usage.data.usage` 返回与 Run.usage 相同的整轮统计。每次通知取提交后的值，覆盖上次展示。重生成时多次相加会重复计算摘要。平台要查询单轮或会话统计均无需展开 entry；SDK 是否开放计量另由内容边界决定。

## 写入时序、再生与故障

1. **开场。** 一次事务写 session、初始本地状态、completed Run、与其 assistantEntryId 匹配的 complete 开场消息、初始化能力结果。Run 的 id 与助手 id 独立。无模型请求，保留有效的空建议和初始化 stateUpdate。提交后只发 session.created。
2. **发送。** 先获现有会话许可，在同步事务内重验会话、预期 tip 和无活动 Run；插入 running Run 并追加 complete 用户，推进 tip。事务成功后方可返回 202、启动模型、发布 run.created。唯一活动索引是最后一道并发约束；回复辅助仍与叙事共用既有准入锁。查询活动叙事只读 runs。
3. **生成及停止。** SSE 的正文、reasoning_content、最终模型 snapshot 仍为瞬时输出。stop 核对 sessionId、runId、assistantEntryId，事务把 running 改为 stopping，再 abort 控制器；同执行 stopping 可重复应答，旧 ID 和已结算执行不能停止新执行。stop 和结算按实际提交顺序裁决，先接受用户停止则按 cancelled 结算。
4. **结算。** 在同一同步事务重验 writePermit、当前执行、活动状态和预期 tip。正常输出执行后处理并追加 complete 助手，保存有效状态、能力、主请求事实、finishedAt 和终态。中断而有公开输出时追加 partial（包括仅思考或现行允许保存的工具快照）；无可保存输出就只结算 Run。中断不执行后处理。事务返回实际 savedMessageIds、tipEntryId 和已提交回执，按许可身份解锁后发布 state.changed、适用的建议/立绘、run.usage，最后 run.completed 或 run.stopped。每项发布独立处理订阅者异常。成功终态到达后立即查询必须可见同次结算，除非已有下一次再生替换它。
5. **重新生成。** 仅最新有用户输入的一轮可再生，含末次仅剩 user 的情形；开场、旧轮和活跃轮拒绝。单事务校验会话 tip、待替换轮和上一次预留执行 ID，保留 run id、page_key、created_at、user 及已提交摘要。删除原助手（若存在）、修复父链/tip、清空 capabilities、main、finished_at、stop_reason，设置新 assistantEntryId 与 running。先发布已提交的 message.deleted 和实际状态变化，再发带新执行 ID、真实 tip 与 deletedMessageIds 的 run.created；之后共用发送流程。再生失败不恢复旧助手。迟到的旧 delta 可以按执行 ID 丢弃；旧执行的终态写入使用带身份条件的 UPDATE，影响行数非一即放弃，不得覆盖新结果。
6. **写失败与重启。** 业务写事务回滚后，尝试独立最小事务按同一身份写 stopped 与真实失败原因（如 tip_conflict 或 message_persist_failed）。有请求指标且可合法保存时一并记账。先前已独立提交的摘要保留。数据库连最小结算也写不动时，记录存储故障、阻止继续受理、关闭受影响事件连接并让服务进入故障处理；不得发成功或伪造已保存的终态。服务独占数据根启动时，在监听前把遗留 running 终止为 stopped/server_shutdown，把已受理用户停止的 stopping 终止为 stopped/cancelled；正常关闭以已有控制器收尾。若启动结算失败则不监听。此操作不重发 prompt、不恢复模型流。启动收尾以独占数据根为前提。部署需先结束旧进程，再启动新进程；禁止两个 Server 共写同一库时启动扫描。会话正常删除受锁保护；异常发现会话已消失时走 session_deleted 诊断/缺失响应，禁止为不存在的会话造孤儿 Run 或历史。

## Compaction 的影响

例如 R8 的树为 `U8 → C8 → A8`。C8 的 run_id 是 R8，coveredThroughEntryId 可能是 R2 的最后一条消息。C8 算 R8 的摘要请求，不占一个分页名额，也不向用户显示为消息。再生成 R8 时删除 A8，C8 和摘要费用保留；预期 tip 在受理前可能为 A8，受理回执里的实际 tip 是 C8。新助手接在实际准备完成后的 tip。若此时新主调用失败，R8 仍可包含 U8、C8，查询只展示 U8，计量仍含 C8。

保留已有完整轮边界、待答用户保护与滚动摘要保护最近五个历史轮的规则。继续通过 coveredThroughEntryId、完整消息边界和覆盖前缀的 sourceHash 判断摘要能否复用。当前 hash 取普通消息的 id、seq、runId、role、content；Run 终态、能力输出或用量变化不应使正文摘要失效。被覆盖的正文编辑或删除后重新校验。prepareContext 的业务输入仍仅 sessionId，首次 await 前捕获状态、条目与对应的 Run 输出；摘要提交时重查 tip 和来源，助手写入必须接在可能新产生的摘要之后。Context 通过 Session 模块同时追加摘要与计量，保持与 Narrative/EventHub 独立。

模型历史 notes 先选最近两条可见助手，再按其 entry.id 与 run.assistantEntryId 精确匹配批量捕获的输出。保留现行 state / action / sprite 顺序、空块、损坏输出与能力授权规则，不补取更旧回复，不在每个预算候选中查询数据库。帮答仍只读消息、有效摘要和允许的材料。

## Server 契约与分页

HTTP 继续沿用 `/api/v1/sessions/:id/narrative` 前缀；模型实现的目录名不约束后续 SDK 命名。以下为响应 data 部分。id 均为字符串，时间为现行毫秒时间戳。

| 操作 | 输入及返回 |
| --- | --- |
| GET /runs | limit 默认 5，范围 1–5，可给 cursor。返回 {items: Run[], hasMore, nextCursor, activeRunId, tipEntryId}。activeRunId 和 tipEntryId 是整场会话当前值，与本页是否包含活动轮无关。 |
| GET /runs/:runId | 精确回读终态或补单轮，返回同一 Run DTO。先校验会话访问与 run 归属，跨会话用相同的未找到语义。 |
| POST /runs | 现有 input.text、expectedTipEntryId。202 延用 runId、assistantEntryId、userEntryId、userMessage（含 status）、tipEntryId、deletedMessageIds。 |
| POST /runs/regenerate | {runId, expectedAssistantEntryId, expectedTipEntryId}。即使上次没有保存助手，也能从 Run 取得预留 ID，有效拒绝旧请求的延迟重试。Server 在锁内找本轮用户与实际旧助手，返回同一受理结构。 |
| POST /runs/:runId/stop | {assistantEntryId}，匹配当前执行后返回现有停止受理回执。 |
| GET /usage | 保留会话记录用量及 latestContext，改从 runs.metrics_json 读取。 |
| 会话 SSE 和按消息读立绘 | SSE 地址不变。现有单条消息立绘读入口经身份校验投影所属轮输出，用户消息返回 null，摘要拒绝，已删除/异会话消息未找到。资源文件继续经既有资源入口加载。 |

Run DTO 包含 `id, status, stopReason, assistantEntryId, createdAt, finishedAt, messages, capabilities, usage`。stopReason、finishedAt 无值时显式 null。messages 按 seq 升序，仅含已保存的普通消息，每条含 id、role、status、timestamp、content 和已保存的可选 reasoning_content、tool_calls（仅助手）。capabilities 为该次执行的持久结果。内部摘要正文、原始计量快照和 parent 链不进轮次消息列表；发命令所需的真实 tip 从页或受理回执取得。

分页从 runs 按 session_id 与 page_key 降序取 limit+1，严格小于 cursor 的 beforePageKey。以最后一个实际返回的轮生成 nextCursor，尾页为 null。沿用 HTTP 游标编解码器，使用新作用域和会话 ID，拒绝跨会话、旧 beforeSeq、afterSeq、未知参数和非法 limit。即使边界轮被删除，其排序键仍可继续定位。一次数据库读快照内完成页、活动 ID、tip、该页消息的批量查询。再生、摘要和结算不换页键，新轮出现在首屏。重新连通读取近期页，指定轮用详情确认；不承诺 cursor 是全会话历史快照或变更日志。

**例：** R8 达到输出长度上限后，GET /runs/R8 返回 status=stopped、stopReason=output_limit_reached、assistantEntryId=A8，messages 中 U8 为 complete、A8 为 partial。run.stopped 同时带 runId=R8、assistantEntryId=A8、stop_reason=output_limit_reached、savedMessageIds=[U8,A8] 与提交后的 tip。若凭据缺失，原因是 credential_not_configured，savedMessageIds 只有 U8。精确原因不依赖解析错误文案或有无回复。

停止原因使用一份 Server 枚举，HTTP `stopReason` 与 SSE `stop_reason` 命名沿用各自现行格式，值严格相同。首发清单如下，展示层分组不改变协议值：

```text
cancelled
server_shutdown
provider_aborted
provider_error
provider_context_window_exceeded
model_not_found
model_capability_unsupported
credential_not_configured
credential_unavailable
context_budget_exceeded
invalid_context
output_limit_reached
output_incomplete
model_output_invalid
tool_execution_unsupported
summary_capacity_exceeded
summary_failed
message_persist_failed
tip_conflict
session_deleted
internal_error
```

run.created 的用户投影同样带 complete。run.delta 保留增量正文、思考文本和最终替换快照；run.completed/stopped 的身份和已存 ID 能与持久消息逐个对应。run.summarizing、run.summarized、run.usage 仍是 Server 会话事件。发布方复用同一结算回执；SSE 无回放，崩溃恰好发生在提交后、通知前时，HTTP 仍读得到最终记录。Run 查询描述叙事活动；独立 reply assist 的占用通过原有准入机制处理，不能从 activeRunId=null 推断所有平台命令一定成功。

## 首发切换与交接

这次是 Server 存储与传输契约的一次破坏性变更。现有 Web 使用 entry 分组、afterSeq 和旧再生参数，单独替换生产 Server 会破坏现有运行页。先在独立数据根完成 Server 验收，冻结分页、终态、再生和计量样例，下一项工作才更新前端架构、SDK 和验收用例；前后端配套后上线。其余模型提供商、世界卡格式、预设语法、会话配置、状态 API、资源服务与传输协议均可沿用。实现的变更文件树、故障用例和发布门槛见[实施任务](服务端Run实体与消息状态任务.md)。
