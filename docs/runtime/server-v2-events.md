# Server V2 会话事件

ServerV2 的叙事用例和会话 SSE 共用一个 EventHub。事件传输代码位于 `apps/serverV2/src/infrastructure/events/`；业务执行和终态判断位于 `usecases/narrative/`。原 Server/Studio 保持独立，StudioV2 尚未接入叙事运行 UI。

EventHub 按 sessionId 选择订阅集合，再同步通知该会话的监听器。事件仅包含 event 和 data，publish 不返回值；不生成事件 id，也不输出 SSE `id:`。单个订阅者抛错不会中断发布者或其他订阅者。业务提供完整事件，SSE 只负责订阅、编码和连接生命周期，不读取数据库或判断运行是否结束。

## HTTP 与装配

会话连接入口是 `GET /api/v1/sessions/:id/events`，由 routes/sessions.ts 注册。路由先通过 SessionService 检查真实会话，再执行可选 canAccessSession；不存在或无权访问统一返回 SESSION_NOT_FOUND/404。权限检查等待结束后先检查关闭状态，再确认会话仍存在。默认本地服务允许访问已存在的会话；访问适配器不能代替存在性检查。

SSE 建立前的错误使用普通 JSON 包络，建立后返回原始 text/event-stream。HEAD 只检查响应头，不建立订阅或心跳。未装配业务 Services 的应用返回 SERVICE_UNAVAILABLE/503。普通 HTTP 路径、Origin 边界和响应契约见 [Server V2 HTTP](server-v2-http.md)。

使用 `pnpm --filter @sillyrealms/server-v2 dev` 或 `pnpm --filter @sillyrealms/server-v2 start` 启动。默认监听 `127.0.0.1:3001`，SERVER_V2_PORT 可覆盖端口；默认数据根目录为仓库 `runtime/server-v2/`，SERVER_V2_DATA_ROOT 可覆盖，库文件为其下 database.sqlite。启动检查独立 V2 数据库结构，不读取或改造旧 Server 库；GET /health 返回 data:{ok:true}，只表示 HTTP 进程存活。

startServer 创建共享数据库连接、业务 Services、用例、PiClient 和 EventHub；SSE 与 narrative 使用同一事件实例。数据库和 Repository 不向 HTTP 调用方暴露。业务在进程内发布事件，没有公开的 HTTP 事件发布入口。

## 叙事事件

客户端应先连接事件流，再提交叙事。事件可能早于提交请求的 202 响应，消费端使用 runId 和 messageId 关联，不依赖响应与事件先后。

| event | data 字段 | 含义 |
| --- | --- | --- |
| run.started | runId、userEntryId、assistantEntryId | 用户消息已保存，助手 ID 已预分配，本轮开始处理 |
| message.delta | runId、messageId、offset、text | 助手正文追加，messageId 为预分配的助手 ID |
| run.completed | runId、userEntryId、assistantEntryId、tipEntryId | 完整助手正文已独立保存，assistantEntryId 必为字符串 |
| run.failed | runId、userEntryId、assistantEntryId、tipEntryId、errorCode、errorMessage | 本轮失败，用户已保留；assistantEntryId 非 null 表示部分正文已保存 |
| run.stopped | runId、userEntryId、assistantEntryId、tipEntryId | 取消已结束；有可保存正文则已保存，否则 assistantEntryId 为 null |

message.delta.offset 是追加之前正文的 JavaScript 字符串长度，即 UTF-16 code unit 数，不是字节数、token 数或事件序号。text 只包含可见正文，不包含 thinking。没有增量但模型最终事件包含正文时，会补发正文增量。

一次运行只产生一个终态。助手保存完成、当前会话内存占位释放后才发布终态；消费者处理终态时可提交下一轮。若助手保存失败，终态为 run.failed，assistantEntryId=null，不把展示过的文本宣称为已保存历史。

run.started 和 202 中的 assistantEntryId 只是预分配标识；最终是否存在该消息，以终态的实际 assistantEntryId 和条目读取结果为准。失败/停止没有正文或只有空白时，不创建空助手消息。tipEntryId 是结束步骤读取到的实际会话 tip；发生外部追加时可能不是本轮用户或助手，会话已删除时可为 null。

失败码与公开描述取自 errors.ts，不回显供应商原文、密钥、数据库错误或堆栈。持久化规则、模型终态校验及指标语义见 [叙事执行](server-v2-narrative.md)。

SSE 示例：

```text
event: message.delta
data: {"runId":"run-1","messageId":"assistant-1","offset":0,"text":"庭院里传来脚步声。"}

event: run.failed
data: {"runId":"run-1","userEntryId":"user-1","assistantEntryId":"assistant-1","tipEntryId":"assistant-1","errorCode":"PROVIDER_ERROR","errorMessage":"模型请求失败"}

```

示例中生成失败，但收到的正文已独立保存；刷新后仍能从 entries 读取。没有消息级回滚，也没有以失败事件删除用户消息的语义。

## 连接生命周期

- 一个连接覆盖当前会话的多轮运行；完成、失败、停止都按普通事件转发，不关闭 SSE。
- 请求断开、响应体取消、服务关闭、连接积压超限或事件无法安全编码时清理连接。清理移除订阅、心跳和 abort 监听，不取消叙事；停止生成须显式调用 stop。
- 心跳间隔为 15 秒，每条连接尚未被 HTTP 层读取的 UTF-8 数据队列上限为 256 KiB。超限只关闭该连接，不阻塞其他订阅者；HTTP 层已读取也不代表客户端已收到。
- 事件即时推送，不持久化、确认或回放。重连只接收新事件；以 entries/history 中已保存的消息为准，不提供运行终态恢复或自动重发。
- 同会话可以有多个事件连接；连接数量不改变该会话一次只能执行一轮的业务限制。

## 服务关闭

SIGINT/SIGTERM 或 close() 先停止受理并取消当前叙事，等待本地取消路径保存已经收到的正文并发布终态，再结束 SSE、停止 HTTP 和关闭数据库。模型供应商不响应取消时，也不会无限阻塞本地消费者；迟到结果不再保存。

HTTP 关闭阶段超过 3.5 秒的剩余连接会被强制断开。close() 可重复调用，监听启动失败也会释放资源。强制终止进程不经过上述结算，已落库用户保留，尚在内存的助手正文可能丢失；没有重启恢复或逐分片持久化。

## 验证边界

本期通过函数级有限流替身、临时或内存 SQLite、直接 EventHub 订阅以及 typecheck/lint 验证叙事、事件隔离和停止保存。不会在该验证流程中启动服务、访问真实模型、调用真实 Keychain 或新增 HTTP/浏览器模拟环境。已有 HTTP 集成测试保留在仓库，未纳入本期验证范围。
