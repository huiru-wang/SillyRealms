# Server V2 会话事件

当前已实现事件模块、Hono 业务路由、Node HTTP 启动及独立 V2 存储 Service；旧 Server 和 Studio 尚未切换到 V2。此阶段不建立 engine、任务抽象或应用通知。

EventHub 由应用装配时创建，供业务发布者和连接入口共享。业务提供完整事件名称及数据，SSE 层只按会话订阅并编码，不读取 Runtime 或数据库。接入路由时须先检查会话存在性和访问权限，再传入请求 AbortSignal；服务关闭信号由应用统一提供。

EventHub 首先按 sessionId 选择订阅集合，再同步通知该会话的监听器。事件仅包含 `event` 和 `data`，publish 不返回值；不生成事件 id，也不输出 SSE `id:` 字段。

## HTTP 接入

使用 `pnpm --filter @sillyrealms/server-v2 dev` 或 `pnpm --filter @sillyrealms/server-v2 start` 启动。默认监听 `127.0.0.1:3001`，可用 `SERVER_V2_PORT` 覆盖。V2 默认数据根目录为仓库的 `runtime/server-v2/`，可用 `SERVER_V2_DATA_ROOT` 覆盖，库文件固定为其下 `database.sqlite`。启动先打开独立 V2 数据库，版本或结构不符会拒绝启动，不读取或改造旧数据库。`GET /health` 只表示 HTTP 进程存活，使用统一 JSON 成功包络，data 为 `{ ok: true }`。普通 HTTP 契约见 [Server V2 HTTP](server-v2-http.md)。

会话连接入口为 `GET /api/v1/sessions/:id/events`，由 routes/sessions.ts 注册。路由先通过 SessionService 检查真实会话，再执行可选的 `canAccessSession(sessionId, request)` 权限检查，通过后才订阅事件；不存在或无权访问统一返回 404。权限等待结束后检查关闭信号，并再次确认会话存在，防止给已删除会话建立连接。默认本地服务允许访问已存在的会话；自定义适配器不能代替会话存在性检查。单独创建未接入业务 Services 的应用返回 503 SERVICE_UNAVAILABLE。SSE 建立前的失败使用统一 JSON 错误包络，建立后的事件流仍为原始 text/event-stream。真实 HTTP 集成测试覆盖持久化会话重启读取、允许/拒绝、权限等待期间删除和事件隔离。

`startServer` 每次启动创建一份数据库连接，由 services.ts 装配六个业务 Service，共享一个 EventHub。返回值为 `services`、`events`、`server`、`close`；Repository 与数据库留在模块和启动生命周期内部，世界文件能力由 WorldService 提供。调用链为 route → service → repository，跨模块通过 Service 编排。业务在进程内调用 publish；没有公开的 HTTP 事件发布入口。

SIGINT/SIGTERM 或调用返回值 `close()` 时，先发出应用关闭信号，结束 SSE，再停止 HTTP 服务，最后关闭数据库。监听启动失败也会释放连接；`close()` 可重复调用。3.5 秒内仍未关闭的连接将被强制断开；不会调用业务取消接口。

## 生命周期

- 连接覆盖当前会话的多轮运行；完成、失败、停止及其他业务事件都按普通事件转发，不关闭连接。
- 只有请求断开、响应体取消、服务关闭、连接积压超限或事件无法安全编码时才清理连接。清理会移除订阅、心跳和 abort 监听，不修改业务状态。
- 心跳间隔为 15 秒。每条连接的流队列上限为 256 KiB，指尚未被 HTTP 层读取的 UTF-8 编码数据积压，不是连接累计传输量；超限关闭该连接，不阻塞其他订阅者。已被 HTTP 层取走也不代表客户端已收到。
- 事件即时推送，不持久化、确认或回放。断线重连只接收新事件；业务结果的查询和恢复由后续接入模块负责。

## 验证

运行 `pnpm --filter @sillyrealms/server-v2 test`、`pnpm --filter @sillyrealms/server-v2 typecheck` 和 `pnpm --filter @sillyrealms/server-v2 lint`。根目录同名命令也包含该包。HTTP 集成测试监听系统分配的回环端口，使用临时或内存 SQLite，验证实际网络推送、会话访问边界、重启读取、断开清理、重连及服务/数据库关闭；不访问真实模型或旧用户数据库。
