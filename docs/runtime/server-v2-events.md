# Server V2 会话事件

当前已实现 `apps/serverV2/src/events/`、最小 Hono 应用及 Node HTTP 启动入口；旧 Server 和 Studio 尚未切换到 V2。此阶段不建立 engine、任务抽象或应用通知。

EventHub 由应用装配时创建，供业务发布者和连接入口共享。业务提供完整事件名称及数据，SSE 层只按会话订阅并编码，不读取 Runtime 或数据库。接入路由时须先检查会话存在性和访问权限，再传入请求 AbortSignal；服务关闭信号由应用统一提供。

EventHub 首先按 sessionId 选择订阅集合，再同步通知该会话的监听器。事件仅包含 `event` 和 `data`，publish 不返回值；不生成事件 id，也不输出 SSE `id:` 字段。

## HTTP 接入

使用 `pnpm --filter @sillyrealms/server-v2 dev` 或 `pnpm --filter @sillyrealms/server-v2 start` 启动。默认监听 `127.0.0.1:3001`，可用 `SERVER_V2_PORT` 覆盖；不读取旧数据库。`GET /health` 只表示 HTTP 进程存活。

会话连接入口为 `GET /api/v1/sessions/:id/events`。路由调用 `canAccessSession(sessionId, request)` 检查会话存在性及本次请求的访问权限，通过后才订阅事件；不存在或无权访问统一返回 404。检查能力未接入时返回 503，默认启动入口处于此状态，不生成假会话。当前由真实 HTTP 集成测试注入会话夹具验证允许、拒绝及隔离行为。

`startServer` 每次启动只创建一个 EventHub，并将其交给应用路由，同时通过返回值 `events` 提供给后续业务。业务在进程内调用 publish；没有公开的 HTTP 事件发布入口。

SIGINT/SIGTERM 或调用返回值 `close()` 时，先发出应用关闭信号，结束 SSE，再停止 HTTP 服务。3.5 秒内仍未关闭的连接将被强制断开；不会调用业务取消接口。

## 生命周期

- 连接覆盖当前会话的多轮运行；完成、失败、停止及其他业务事件都按普通事件转发，不关闭连接。
- 只有请求断开、响应体取消、服务关闭、连接积压超限或事件无法安全编码时才清理连接。清理会移除订阅、心跳和 abort 监听，不修改业务状态。
- 心跳间隔为 15 秒。每条连接的流队列上限为 256 KiB，指尚未被 HTTP 层读取的 UTF-8 编码数据积压，不是连接累计传输量；超限关闭该连接，不阻塞其他订阅者。已被 HTTP 层取走也不代表客户端已收到。
- 事件即时推送，不持久化、确认或回放。断线重连只接收新事件；业务结果的查询和恢复由后续接入模块负责。

## 验证

运行 `pnpm --filter @sillyrealms/server-v2 test`、`pnpm --filter @sillyrealms/server-v2 typecheck` 和 `pnpm --filter @sillyrealms/server-v2 lint`。根目录同名命令也包含该包。HTTP 集成测试监听系统分配的回环端口，验证实际网络推送、会话访问边界、断开清理、重连和服务关闭；不连接真实模型或数据库。
