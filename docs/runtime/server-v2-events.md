# Server V2 会话事件

ServerV2 的叙事用例和会话 SSE 共用一个 EventHub。业务消息遵循 ServerV2 自有契约，pi 只负责 SDK 适配；消息结算属于 `usecases/narrative/`，传输位于 `infrastructure/events/`。本契约仅在 ServerV2 实施，Studio、StudioV2 与共享前端运行 SDK 暂不适配。

EventHub 按 sessionId 同步通知监听器。事件仅包含 event 和 JSON 对象 data；不生成 SSE `id:`，没有确认或回放。单个订阅者失败不影响业务执行或其他连接。SSE 不读取数据库、不判断运行是否结束。

## HTTP 与装配

入口为 `GET /api/v1/sessions/:id/events`。路由检查真实会话及可选访问权限，不存在或无权访问统一返回 SESSION_NOT_FOUND/404。等待权限检查后再次检查停机状态和会话存在性。

SSE 握手前的错误仍用普通 HTTP JSON 包络；建立后返回原始 text/event-stream。HEAD 只检查响应头，不订阅或发送心跳。startServer 为叙事与 SSE 装配同一个 EventHub。

客户端应先建立事件连接再提交叙事。事件可能早于提交请求的 202 响应，使用 runId/messageId 关联，不能依赖 HTTP 响应和事件先后顺序。

## 运行事件契约

生产中的每个 run 事件都包含：

| 字段 | 含义 |
| --- | --- |
| runId、sessionId | 本轮与会话身份 |
| provider、model | 配置中的 providerId、modelId；准备失败而无法取得配置时为 null |
| timestamp | 生成该事件时的服务端 Unix 毫秒时间；不是事件序号或去重键 |

run.created 中用户消息的 timestamp 是其保存时的消息时间。messageId 与实际 entry ID 使用同一身份；预分配 ID 不表示条目已经保存。

| event | 特有 data 字段 | 含义 |
| --- | --- | --- |
| run.created | messages: [{id,role:"user",content,timestamp}] | 已受理且用户消息已保存；不保证模型调用已开始 |
| run.delta | messageId、messages（固定一个元素） | 同一条助手消息的正文、公开 reasoning 或工具调用增量，以及最终公开快照 |
| run.usage | usage | 本轮总用量快照，每个已受理 run 仅发布一次，不带 messageId/requestId |
| run.completed | savedMessageIds、tipEntryId | 本轮成功并完成持久化结算 |
| run.stopped | savedMessageIds、tipEntryId、stop_reason | 取消或失败已经结算；只使用原因码，不含 error、errorCode 或 errorMessage |

普通请求校验或用户写入失败不创建 run.created。用户保存后的准备、生成、停止和保存错误都通过同一轮的 run.stopped 收敛，不再发布 run.started、message.delta 或 run.failed。

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

content 和 reasoning_content 分别追加；工具参数按本条消息中的 index 追加。index 是消息内工具序号，不是并行执行保证，也不是 SDK 混合内容数组的 contentIndex。id、工具名称等标识字段采用赋值，允许在参数增量之前或之后到达；tool result 使用 tool_call_id 关联。arguments 是字符串，增量中可以是不完整 JSON，不能直接执行。

snapshot 是该消息完整公开内容，采用替换语义；空 delta 不清空已有内容，snapshot 不能重复追加。SDK 最终正文、reasoning 和工具参数可能修正增量，因此必须以最终公开快照为准。没有增量时也可直接用快照显示最终消息。

finish_reason 描述一次模型输出结束，不代表数据库保存成功或整轮业务成功。正常 stop 且存在正文、没有工具请求并保存成功时才发布 run.completed。length/deferred 归为输出不完整；本期没有工具执行能力，收到工具请求后保留公开内容并以 tool_execution_unsupported 结束。失败或取消也会冻结并发送当前公开快照，不伪造 finish_reason=stop。

公开 reasoning 不包含 SDK thinkingSignature、textSignature、工具签名、redacted 数据或原始 provider 错误。工具执行、模型继续调用和私有签名回放尚未实现。

### 一次运行的总 usage

每个已受理 run 在消息保存及用户 entry 的结束结果结算后发布一次 run.usage，随后发布唯一 run.completed 或 run.stopped。运行占位在发布结算事件前释放；终态后不再发送本轮增量或用量。SSE 连接继续存在。

usage 为以下对象或 null：

```ts
{
  input_tokens: number,
  output_tokens: number,
  cache_read_tokens: number,
  cache_write_tokens: number,
  total_tokens: number
}
```

输入总量包含缓存读写，缓存字段是细分；total_tokens=input_tokens+output_tokens，reasoning 已包含在输出时不重复相加。计量是快照，不能将累计值重复相加。

没有开始 SDK 调用尝试时，总量为真实全零；已经开始调用但没有可信统计时为 null。内部 request_started 仅表明调用尝试，不承诺网络已经发送字节。停止不等待迟到 usage，也不在终态后补发。本期只有一次模型调用，其最终计量就是本轮总量；未来增加调用时应先按请求归集，再发布一份完整总量，缺失的统计不得用已知小计冒充总量。

usage 不代表消息保存成功。现有 metrics 随助手 entry 保存；没有可保存助手或保存失败时，实时 usage 不一定有历史指标载体，不新增 run 表或账单存储。

### 终态与保存结果

savedMessageIds 表达本轮结算确认保存的消息，tipEntryId 是结算读取的实际会话 tip。部分消息已保存时也列入 savedMessageIds；保存失败时不把预分配助手 ID 列为已保存。会话不存在时 tip 可为 null。独立的删除操作不由生成回滚或恢复。

停止原因包括用户取消、服务关闭、模型或凭据不可用、上下文/输出错误及持久化失败，采用稳定的小写原因码。典型值为 cancelled、server_shutdown、provider_error、provider_context_window_exceeded、model_not_found、credential_not_configured、context_budget_exceeded、output_incomplete、model_output_invalid、tool_execution_unsupported、message_persist_failed、tip_conflict。保存失败优先于原来的取消或生成原因。详细异常留在服务端，不对外转发 SDK 错误对象。

例如模型请求失败，但部分助手内容已保存：

```text
event: run.stopped
data: {"runId":"r-1","sessionId":"s-1","provider":"deepseek","model":"deepseek-flash","timestamp":1763520101000,"stop_reason":"provider_error","savedMessageIds":["m-1","m-2"],"tipEntryId":"m-2"}

```

成功同样使用 JSON run.completed，不输出裸 [DONE]。看见完整正文或模型 finish，不足以确认保存成功；以 run 终态和 entries/history 读取结果为准。

## 状态事件

`state.changed` 的 data 保持 `{path,scope,value}`。成功提交后仅推送有效状态的实际变化：PATCH 逐字段发布完整新值；PUT 或追加独立消息快照使用 `path: ""` 和完整对象，接收方替换整个 scope，`{}` 清空，null 仍是普通字段值。空路径不能用于 PATCH 请求。

- global 发送到该世界的全部会话；session/message 只发送到所属会话，所有连接均可接收。
- message 对应当前 tip 的有效继承视图，存储数组/null 转为对象。历史 entry 修改仅在影响当前 tip 时推送；恢复 null 继承发送继承后的完整对象。
- 缺失路径忽略、同值、失败及回滚不发布；读取和初始化也不发布。PATCH 每项提交后推送，再处理下一项。
- 普通消息追加若改变有效状态，保存 entry 并推进 tip 后推送完整快照。叙事当前追加 null 状态，不改变继承视图，不生产自动状态更新。

发布由用例编排，StateService 计算变更，接收会话由 SessionService 查询；EventHub 保持独立。事件没有持久化/重放，初次装载及重连应重新读取状态快照。详见 [状态接口](server-v2-http.md#状态接口)。服务端契约已实现，StudioV2/SDK transport 的接入另行完成。

## 预留事件

预留类型在服务端契约中定义，本期不生成 system、工具结果或行动建议：

- system 编译产物仍使用 run.delta，messages 为单个 `{role:"system",delta:{content}}`，不落库、不推送。
- 工具结果仍使用 run.delta，messages 为单个 `{role:"tool",delta:{tool_call_id,name,status,content,is_error}}`，由未来的业务执行层产生。当前不执行工具或保存 role=tool entry。
- action_suggestions.changed 使用 sessionId、runId、messageId、items；items 整组替换，空数组表示清空，不追加重复事件。

预留扩展独立于模型 run 生命周期，未来可以在叙事终态后发布。定义类型不等于迁移摘要或扩展执行逻辑。

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

事件传输仍为 `/api/v1/sessions/:id/events`，没有 narrative/events、SSE id 或回放。轮次查询位于 narrative/runs：客户端重连后按已有 seq 补查新增 entries，并刷新原来运行中的那一轮的详情；退出后重新进入则读取最新 5 轮。未落库的断线分片无需补齐，现有最终 snapshot 保持替换语义。

用户 entry 的 extData.narrative 保存 `{status,finishedAt,stopReason?}`，正常完成为 completed，其他结算为 stopped，stopReason 与本事件契约相同；写入失败不回滚已存消息。metrics.requests 改为 provider/modelId/requestId/usage/时间信息，不再存 status。公开事件结构没有因此改变。
