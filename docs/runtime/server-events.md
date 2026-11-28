# Server 会话事件

Server 的叙事用例和会话 SSE 共用一个 EventHub。业务消息遵循 Server 自有契约，pi 只负责 SDK 适配；消息结算属于 `usecases/narrative/`，传输位于 `infrastructure/events/`。本页定义服务端事件；各前端能力按已接入的契约消费。Web 宿主消费立绘事件，并通过现有会话事件订阅转发给舞台。

EventHub 按 sessionId 同步通知监听器。事件仅包含 event 和 JSON 对象 data；不生成 SSE `id:`，没有确认或回放。单个订阅者失败不影响业务执行或其他连接。SSE 不读取数据库、不判断运行是否结束。

## HTTP 与装配

入口为 `GET /api/v1/sessions/:id/events`。路由检查真实会话及可选访问权限，不存在或无权访问统一返回 SESSION_NOT_FOUND/404。等待权限检查后再次检查停机状态和会话存在性。

SSE 握手前的错误仍用普通 HTTP JSON 包络；建立后返回原始 text/event-stream。HEAD 只检查响应头，不订阅或发送心跳。startServer 为叙事与 SSE 装配同一个 EventHub。

客户端应先建立事件连接再提交叙事。事件可能早于提交请求的 202 响应，使用 runId/messageId 关联，不能依赖 HTTP 响应和事件先后顺序。

## 会话创建事件

创建会话和首条消息的事务提交成功后，仅发布一次 session.created：

```ts
{
  event: 'session.created',
  data: {
    sessionId: string,
    tipEntryId: string,
    timestamp: number,
    opening: { runId: string, message: {id: string, role: "assistant", status: "complete", content: string, timestamp: number} }
  }
}
```

opening.message 是与创建响应和详情相同的公开消息，timestamp 使用开场消息的保存时间。

创建没有执行叙事，不发布 run.created/run.delta/run.usage/run.completed 或 state.changed。由于首次创建时可能没有 SSE 连接，POST 响应同时提供 item 与 opening；初始显示以响应或历史查询为准，不等待创建事件。失败回滚时不发布任何事件。

## 世界内容更新

在同一 worldId 下成功应用指定发行版后，向该世界每个关联会话发布一次：

~~~ts
{
  event: 'world.updated',
  data: {
    sessionId: string,
    worldId: string,
    version: string,
    revision: number,
    timestamp: number
  }
}
~~~

version 为实际安装的 publication.release.version，revision 为已提交的世界修订号，timestamp 为 Unix 毫秒。事件只在正式内容成功替换并提交后发布；检查目录、查看说明、下载准备及失败/回滚不发送。它不带 runId，不属于某轮模型输出，也不增加专用更新 SSE。

接收方继续通过已授权的 `/sessions/:id/events` 连接读取，验证 sessionId 与所属 worldId 后重新获取世界详情、组件及相关资源。发行版本变化重建预览或舞台，保留会话工作区、消息历史和输入草稿。事件本身不重放；初次进入、连接恢复和显式同步重读世界数据，不能只靠曾收到的通知判断版本。完整覆盖边界见[世界版本接口](server-http.md#世界版本与覆盖)。

## 运行事件契约

生产中的每个 run 事件都包含：

| 字段 | 含义 |
| --- | --- |
| runId、sessionId | 逻辑轮次与会话身份 |
| assistantEntryId | 本次执行预分配的新 AI 消息身份；同轮重新生成时变化 |
| provider、model | 配置中的 providerId、modelId；准备失败而无法取得配置时为 null |
| timestamp | 生成该事件时的服务端 Unix 毫秒时间；不是事件序号或去重键 |

run.created 中用户消息的 timestamp 是其保存时的消息时间。messageId 与实际 entry ID 使用同一身份；预分配 ID 不表示条目已经保存。

| event | 特有 data 字段 | 含义 |
| --- | --- | --- |
| run.created | messages: [{id,role:"user",status:"complete",content,timestamp}]、tipEntryId、deletedMessageIds | 已受理且用户消息已保存；客户端清空上一轮建议，不保证模型调用已开始 |
| run.summarizing | 无额外字段 | 摘要输入校验通过，准备发起摘要调用 |
| run.summarized | entryId | 完整摘要及其 metrics 已保存，entryId 为 compaction ID |
| run.delta | messageId、messages（固定一个元素） | 同一条助手消息的正文、公开 reasoning 或工具调用增量，以及最终公开快照 |
| run.usage | usage | 本轮总用量快照，每次已受理执行仅发布一次，不带 messageId/requestId |
| run.completed | savedMessageIds、tipEntryId | 正文主流程成功并完成持久化结算；不代表每个能力均成功 |
| run.stopped | savedMessageIds、tipEntryId、stop_reason | 取消或失败已经结算；只使用原因码，不含 error、errorCode 或 errorMessage |

普通请求校验或用户写入失败不创建 run.created。用户保存后的准备、生成、停止和保存错误都通过同一轮的 run.stopped 收敛，不再发布 run.started、message.delta 或 run.failed。

摘要由独立 context 模块准备，进度经外层叙事适配到现有事件；context 和 compact 不直接依赖 EventHub 或 SSE。run.summarized 仅由实际已保存摘要回执触发，最终上下文准备失败时仍携带已保存摘要的用量和父链。模型旁注只用于主模型输入，不新增事件，也不进入公开聊天增量。

摘要事件共用 runId/assistantEntryId/sessionId/provider/model/timestamp；不发布 run.phase、generating，不含 data.phase。摘要内部流不发 run.delta。正常顺序为 run.created → 可选摘要事件 → 干净正文 run.delta/最终 snapshot → 持久化及释放执行锁 → state.changed（有变化）→ action_suggestions.created（符合既有建议通知条件）→ character_sprite.changed（有可应用立绘结果）→ run.usage → 唯一终态。摘要失败或取消没有 summarized；成功摘要落库后预算仍超限，summarized 后直接 usage → stopped(summary_capacity_exceeded)，没有正文调用。

### 删除通知与重新生成

`message.deleted` 的 data 为 `{sessionId,runId,assistantEntryId,messageId,tipEntryId}`。messageId 是已删除的旧 AI，assistantEntryId 是将生成的新 AI。只有删除事务成功提交后才发送；不代表新输出成功。实际继承消息状态变化时，紧接着发送标准 state.changed（scope=message、path=""），随后使用正常 run.created。删除通知阶段仍持有本次执行锁。

run.created 和 202 都携带删除后的真实 tipEntryId 与 deletedMessageIds；普通发送和用户无回复重试的删除列表为空。重发的原用户消息按 id 去重。按新 assistantEntryId 隔离本次增量、用量、终态和停止请求；同 runId 可以先后产生多个执行，不能用 runId 永久标记已完成。重复删除回执不回退更新后的 tip。重连读取完整最近轮次，不靠 afterSeq 推断删除。

### 增量与定稿

run.delta 的 messages 固定一个元素，role 为 assistant。delta 使用本次追加量：

```ts
{
  role: 'assistant',
  delta: {
    content?: string,
    reasoning_content?: string,
    tool_calls?: Array<{
      index: number,
      id?: string,
      type?: 'function',
      function?: { name?: string, arguments?: string }
    }>
  },
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'deferred',
  snapshot?: {
    role: 'assistant',
    content: string,
    reasoning_content: string,
    tool_calls: Array<{
      index: number,
      id: string,
      type: 'function',
      function: { name: string, arguments: string }
    }>
  }
}
```

content 先隐藏能力块再追加，reasoning_content 继续独立追加；工具参数按本条消息中的 index 追加。index 是消息内工具序号，不是并行执行保证，也不是 SDK 混合内容数组的 contentIndex。id、工具名称等标识字段采用赋值，允许在参数增量之前或之后到达；tool result 使用 tool_call_id 关联。arguments 是字符串，增量中可以是不完整 JSON，不能直接执行。

snapshot 使用最终模型结果重新分离后的干净 content，是该消息完整公开内容，采用替换语义；空 delta 不清空已有内容，snapshot 不能重复追加。SDK 最终正文、reasoning 和工具参数可能修正增量，因此必须以最终公开快照为准。没有增量时也可直接用快照显示最终消息。

finish_reason 描述一次模型输出结束，不代表数据库保存成功或整轮业务成功。正常 stop 且存在干净正文、没有工具请求并保存成功时发布 run.completed；后处理的 invalid_tag、invalid_json、partial_success 等只记录在 Run.capabilities，不改变该终态。length/deferred 归为输出不完整；本期没有工具执行能力，收到工具请求后保留公开内容并以 tool_execution_unsupported 结束。失败或取消也会冻结并发送当前公开快照，不伪造 finish_reason=stop。

公开 reasoning 不包含 SDK thinkingSignature、textSignature、工具签名、redacted 数据或原始 provider 错误。工具执行、模型继续调用和私有签名回放尚未实现。

### 一次运行的总 usage

结算成功后，服务发送一次 run.usage，接着发送 run.completed 或 run.stopped。data.usage 等于同一执行的 Run.usage，包含 knownUsage、recordedRequestCount、unknownUsageRequestCount。示例为一次无可信 token 的主请求和一次已知用量的成功摘要。

```json
{"knownUsage":{"inputTokens":20,"outputTokens":5,"totalTokens":25,"cacheReadTokens":0,"cacheWriteTokens":0},"recordedRequestCount":2,"unknownUsageRequestCount":1}
```

该值覆盖上次展示。再生保留成功摘要的费用，重复累加会重复计算摘要。

### 终态与保存结果

savedMessageIds 表达本轮结算确认保存的消息，tipEntryId 是结算读取的实际会话 tip。部分消息已保存时也列入 savedMessageIds；保存失败时不把预分配助手 ID 列为已保存。compaction 不列入 savedMessageIds，但摘要后未保存正文时 tipEntryId 可以指向 compaction。执行期间会话消失时丢弃该执行，不发布终态。独立的删除操作不由生成回滚或恢复。

停止原因包括用户取消、服务关闭、模型或凭据不可用、上下文/输出错误及持久化失败，采用稳定的小写原因码。典型值为 cancelled、server_shutdown、provider_error、provider_context_window_exceeded、model_not_found、credential_not_configured、context_budget_exceeded、summary_capacity_exceeded、summary_failed、output_limit_reached、output_incomplete、model_output_invalid、tool_execution_unsupported、message_persist_failed、tip_conflict。保存失败优先于原来的取消或生成原因。详细异常留在服务端，不对外转发 SDK 错误对象。

例如模型请求失败，但部分助手内容已保存：

```text
event: run.stopped
data: {"assistantEntryId":"m-2","runId":"r-1","sessionId":"s-1","provider":"deepseek","model":"deepseek-flash","timestamp":1763520101000,"stop_reason":"provider_error","savedMessageIds":["m-1","m-2"],"tipEntryId":"m-2"}

```

成功同样使用 JSON run.completed，不输出裸 [DONE]。看见完整正文或模型 finish，不足以确认保存成功；以 run 终态和 entries 或 narrative/runs 读取结果为准。

## 状态事件

`state.changed` 的 data 保持 `{path,scope,value}`。成功提交后仅推送有效状态的实际变化：update 逐字段发布完整新值；追加独立消息快照引起有效变化时使用 `path: ""` 和完整对象，接收方替换整个 scope，`{}` 清空，null 仍是普通字段值。空路径不能用于 字段更新请求。

- global 发送到该世界的全部会话；session/message 只发送到所属会话，所有连接均可接收。
- message 对应当前 tip 的有效继承视图，存储数组/null 转为对象。历史 entry 修改仅在影响当前 tip 时推送。
- 缺失路径忽略、同值、失败及回滚不发布；读取和初始化也不发布。update 每项提交后推送，再处理下一项。
- 普通消息追加若改变有效状态，保存 entry 并推进 tip 后推送完整快照。叙事后处理先计算候选及变更，提交助手/状态并释放执行锁后推送完整 message 快照；partial_success 中有效行造成的真实变化同样发布，无变化继续 null 继承且不发事件。

发布由用例编排，StateService 计算变更，接收会话由 SessionService 查询；EventHub 保持独立。事件没有持久化/重放，初次装载及重连应重新读取状态快照。详见 [状态接口](server-http.md#状态接口)。桥接只传递当前投影和原生事件。

## 行动建议创建

本轮有效非空建议已保存，且正文主流程完成时发布：

```ts
{
  event: 'action_suggestions.created',
  data: {
    sessionId: string,
    runId: string,
    messageId: string,
    items: string[]
  }
}
```

messageId 是本轮已保存的助手消息 ID；items 是本轮完整有效集合，客户端整组替换。partial_success 仍可携带有效建议，不能仅因状态能力失败或某条建议为空就丢弃其他有效建议。

标签缺失、空标签、空数组、无有效建议、模型未正常结束或主流程未完成时不发布 created。新 run 的 run.created 已负责清空旧建议，不发送 messageId=null/items=[] 的 created 清空事件，也不增加 cleared。

state.changed、action_suggestions.created 与 character_sprite.changed 独立发布；每条能力通知异常局部处理，继续其余通知及 run.usage/终态，不回滚已提交数据或重新执行能力。能力结果通过 Run.capabilities 读取，事件不重复传输全部诊断。首次加载/重连只恢复最新已完成 run 的有效结果，不回找更早建议冒充当前建议。

## 角色立绘变化

助手消息的可应用立绘结果成功提交并释放执行锁后，发布 character_sprite.changed：

~~~ts
{
  event: 'character_sprite.changed',
  data: {
    sessionId: string,
    runId: string,
    messageId: string,
    items: Array<{
      position: 'left' | 'center' | 'right' | 'top' | 'topleft' | 'topright' | 'truecenter',
      characterId: string,
      spriteId: string,
      asset: string
    }>
  }
}
~~~

messageId 是实际保存结果的助手 entry ID。items 是该消息通过逐行校验的完整快照，角色 ID 和 position 各自唯一；可以超过两项，最多七个有效位置。接收方按消息身份使用整份数组，不把它当增量，不与前一条消息合并。人物与上一条消息相同但来源 messageId 更新时，仍发送通知。

| 保存结果 | 是否通知 |
| --- | --- |
| success，items 非空 | 发送全部有效条目 |
| partial_success | 发送全部通过条目，忽略失败行 |
| success，items=[] | 发送空数组，明确清场 |
| 没有 characterSprite 结果 | 不发送 |
| invalid_items、invalid_tag、processing_error | 不发送；失败的空数组不代表清场 |
| 助手事务失败 | 不发送未提交结果 |

清场事件示例：

~~~text
event: character_sprite.changed
data: {"sessionId":"s-1","runId":"r-2","messageId":"m-2","items":[]}
~~~

SSE 不重复传输行错误诊断。部分成功时仍发送完整有效数组；非空模型块全部失败时保存 invalid_items，不发布清场事件。历史模型旁注补出的空标签也不改变持久结果或产生新事件。

正常结算顺序为：助手事务提交、释放运行锁、state.changed、符合既有条件的 action_suggestions.created、character_sprite.changed、run.usage、唯一终态。能力通知彼此隔离。助手、能力和终态一起提交；写入失败时，回滚并抑制本次能力通知。

重生成沿用 message.deleted：旧助手 ID 被删除，新执行使用新助手 ID。客户端据删除事件使旧消息来源失效；服务端不自动回找更早快照、不合成回退数组，也不合并新旧立绘。事件只说明哪条消息保存了哪份快照，不规定组件显示哪个消息。

读取配合：

- 事件每项的 `asset` 来自本轮捕获的世界素材。历史结果携带同一份已保存的 asset。
- `GET /api/v1/sessions/:sessionId/entries/:messageId/character-sprites` 精确返回该消息的 status/items/errors，未产生结果时为 null，不向前继承。
- 包内素材继续通过 `GET /api/v1/worlds/:worldId/resources/*` 访问；在线素材按既有资源解析规则使用。

事件复用现有会话 SSE，不增加连接、回放或专用资源下载入口。官方悬浮层按 messageId 消费完整快照。接口详情见 [Server HTTP](server-http.md)。

## 预留事件

预留类型在服务端契约中定义，本期不生成 system 或工具结果：

- system 编译产物仍使用 run.delta，messages 为单个 `{role:"system",delta:{content}}`，不落库、不推送。
- 工具结果仍使用 run.delta，messages 为单个 `{role:"tool",delta:{tool_call_id,name,status,content,is_error}}`，由未来的业务执行层产生。当前不执行工具或保存 role=tool entry。

预留类型不代表已经实现工具执行。当前叙事能力通知在唯一终态前发布，终态后不再补发本轮能力结果。

## 连接生命周期

- 一个连接覆盖会话的多轮运行，运行结束不关闭连接。
- 请求断开、响应体取消、服务关闭、积压超限或无法安全编码时清理连接。清理只退订并释放心跳，不取消叙事；生成停止使用显式 stop。
- 心跳间隔为 15 秒。ReadableStream 控制器缓冲为 256 KiB，传输通过 pull 分块输出有界队列；总未读 UTF-8 数据预算为 8 MiB，包含已进入控制器和待发送部分。大定稿快照可跨传输块，但保留原始 SSE 帧与事件顺序；单事件或慢连接总积压超预算时只关闭该连接，不阻塞业务或其他订阅者。
- HTTP 层读到字节不代表客户端已经收到。事件即时推送，不持久化、确认或回放；重连只收到新事件，以已保存历史为准。
- 同一会话可有多个订阅，但业务仍只允许一次运行。

## 服务关闭与验证

正常关闭先停止受理、取消活跃叙事，等待部分内容保存和 usage/终态发布，再关闭 SSE、HTTP 与数据库。关闭 HTTP 阶段超过 3.5 秒的剩余连接会被强制断开；close 可重复调用。强制杀进程不会经过结算，内存中尚未保存的助手内容可能丢失。

验证使用有限模型流、内存或临时 SQLite、直接 EventHub 订阅和 ReadableStream reader，配合 typecheck/lint；不启动服务、访问真实模型或 Keychain，也不新增前端/HTTP 模拟环境。

## 查询配合

事件连接位于 /api/v1/sessions/:id/events。SSE 没有回放。重新连接后读取最近一页 Run，以 activeRunId 定位正在执行的轮；终态后按 runId 精确读取已提交的消息、原因及能力。未持久化的分片可由最终快照替换。

## AI 帮答

宿主订阅现有会话 SSE，以 sessionId、requestId 匹配本页请求。三个事件都包含毫秒 timestamp。

| 事件 | 正文 |
| --- | --- |
| reply_assist.delta | delta.content 为新增正文 |
| reply_assist.completed | snapshot.content 为完整草稿，整体替换缓冲 |
| reply_assist.stopped | stop_reason 及 snapshot.content，保留可用的部分正文 |

受理前的错误由 HTTP 返回。终态在会话锁释放后发布，断线后草稿没有历史回放。宿主不向 Stage 转发这三个事件。
