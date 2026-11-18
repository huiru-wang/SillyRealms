# Server V2 HTTP 契约

## 调用边界

HTTP 适配器位于 `apps/serverV2/src/routes/`，只调用业务模块的 `service.ts`。业务模块唯一公开出口是 Service；Repository 模块内私有且只能访问本模块属主数据。Service 不持有连接或开启事务；启动装配方管理连接生命周期，Repository 只保留本模块必要的原子写入。

业务接口统一前缀为 `/api/v1`。以下路径均省略此前缀，健康检查 `GET /health` 除外。V2 使用独立数据库；旧 Server 和 Studio 尚未切换到这些接口。

## 普通 JSON 响应

成功：

```json
{
  "success": true,
  "errorCode": null,
  "errorMessage": "",
  "data": {
    "item": {
      "id": "preset-1",
      "name": "叙事预设"
    }
  }
}
```

失败（HTTP 404）：

```json
{
  "success": false,
  "errorCode": "PRESET_NOT_FOUND",
  "errorMessage": "预设不存在",
  "data": null
}
```

- 单项读取、创建及更新的 data 为 `{ item }`；列表为 `{ items }`；删除为 `{ id }`。
- 创建返回 201，普通成功返回 200。删除也返回 200 包络，不使用无正文的 204。
- 健康检查返回成功包络，data 为 `{ ok: true }`。
- 失败保留正确的 HTTP 4xx/5xx 状态，不用 200 表示失败。
- 错误码、中文描述及 HTTP 状态统一定义在 `src/errors.ts`。可公开的参数详情并入 errorMessage，不新增 detail/error 等字段。
- 未知异常统一为 INTERNAL_ERROR/500，不暴露原始 SQL、路径、堆栈或回调异常内容。

JSON 写入请求使用 `Content-Type: application/json`（也接受 application/*+json），正文必须是 JSON 对象。请求字段沿用 Service 的 snake_case 类型定义；业务校验由 Service 完成。

| 情况 | HTTP | 常用 errorCode |
|---|---|---|
| JSON 格式无效 | 400 | INVALID_JSON |
| 字段、类型或分页参数无效 | 400 | INVALID_REQUEST 或对应已注册业务校验码 |
| Content-Type 不支持 | 415 | UNSUPPORTED_MEDIA_TYPE |
| 预设、模型、世界、会话或消息不存在 | 404 | PRESET_NOT_FOUND、MODEL_CONFIG_NOT_FOUND、WORLD_NOT_FOUND、SESSION_NOT_FOUND、ENTRY_NOT_FOUND |
| 资源重复 | 409 | RESOURCE_CONFLICT |
| 被引用的数据不能删除或关联数据已变化 | 409 | REFERENCE_CONFLICT |
| 追加前驱不是当前 tip | 409 | TIP_CONFLICT |
| 存储暂时繁忙 | 503 | STORAGE_BUSY |
| 业务 Service 未装配、服务关闭中 | 503 | SERVICE_UNAVAILABLE、SERVER_SHUTTING_DOWN |
| 未知异常 | 500 | INTERNAL_ERROR |

## 预设、模型与默认设置

| 方法 | 路径 | 能力 |
|---|---|---|
| GET / POST | /presets | 预设列表 / 创建 |
| GET / PATCH / DELETE | /presets/:id | 预设读取 / 修改 / 删除 |
| GET / POST | /api-model-configs | 模型配置列表 / 创建 |
| GET / PATCH / DELETE | /api-model-configs/:id | 模型配置读取 / 修改 / 删除 |
| GET / PATCH | /app-settings | 读取 / 更新应用默认预设、模型 |

预设列表支持 type、limit、offset；模型配置列表支持 limit、offset。当前预设只支持已实现校验的 narrative 类型。默认引用可显式写 null 清除；不存在的引用通过属主 Service 报错。

## 世界与文件

| 方法 | 路径 | 能力 |
|---|---|---|
| GET / POST | /worlds | 世界列表 / 创建 |
| GET / PATCH / DELETE | /worlds/:id | 世界读取 / 修改 / 删除 |
| GET | /worlds/tags | 已绑定的标签目录及数量 |
| PUT | /worlds/:id/tags | 替换一个世界的标签，正文必须且只能是 `{ "tags": [...] }` |
| GET / HEAD | /worlds/:id/original | 下载或检查已保存原件 |
| GET / HEAD | /worlds/:id/package/* | 读取或检查包内组件、素材等资源 |

世界列表支持 tag、limit、offset。普通世界更新不接收运行 state；状态通过下述作用域接口写入。

原件下载固定文件名为 `original.json` 或 `original.zip`，反映已保存的原始字节。包资源路径允许子目录，拒绝路径穿越和符号链接；文件打开和流生命周期在世界模块内部处理。

上述下载不等于重新生成世界 ZIP。以当前 DB 世界卡、标签和 package/ 资源构建 `world_name.zip` 的完整导出、ZIP 导入及上传用例仍待后续实施。

## 会话、消息与线性历史

| 方法 | 路径 | 能力 |
|---|---|---|
| GET / POST | /sessions | 会话列表 / 创建 |
| GET / PATCH / DELETE | /sessions/:id | 会话读取 / 修改 / 删除 |
| GET / POST | /sessions/:id/entries | 消息/摘要列表 / 追加 |
| GET / PATCH | /sessions/:id/entries/:entryId | 单条读取 / 正文或 ext_data 更新 |
| GET | /sessions/:id/history | 当前完整线性历史 |
| GET | /sessions/:id/runs/:runId/entries | 按 run_id 分组读取条目 |
| GET / HEAD | /sessions/:id/events | SSE 事件连接 / 仅检查响应头 |

会话列表支持 world_id、limit，以及必须配对的 before_updated_at、before_id 游标。条目列表支持 after_seq、limit。整数 query 必须是合法安全整数，再由 Service 校验允许范围。

本期只做线性追加。parent_id 可省略，默认当前 tip；显式值不匹配时返回 TIP_CONFLICT。新条目、seq 与 tip 的原子更新归 SessionRepository；没有 setTip 或分支切换接口。

HTTP 追加条目不接受 metrics_json，也不提供编辑计量的 HTTP 路由；计量由进程内 SessionService 写入。run_id 只用于条目分组，本期没有 Run 执行路由。

会话范围的读取、修改、状态及 SSE 入口先确认真实会话，再执行可选访问检查；拒绝与不存在统一返回 SESSION_NOT_FOUND。异步检查结束后先检查停机，再确认会话仍存在。配置了访问检查时，会话列表只返回获准条目。

## 完整状态快照

| Scope | GET / PUT 路径 | state 值 |
|---|---|---|
| global | /worlds/:worldId/state | 完整 JSON 对象 |
| session | /sessions/:id/state | 完整 JSON 对象 |
| message | /sessions/:id/entries/:entryId/state | 完整 JSON 数组或 null |

PUT 正文必须且只能包含 state，例如：

```json
{ "state": { "gold": 20, "weather": "rain" } }
```

GET 和 PUT 的成功 data 均为 `{ item: 状态值 }`。PUT 完整替换该 scope 快照；它不是按路径合并接口。消息 GET 返回沿前驱继承后的有效快照；PUT 写入的是指定条目本身。消息 null 恢复继承，空数组表示明确的空快照；有效的 null 与消息不存在分别返回成功和 404。

状态规则解释、按路径 PATCH 和模型输出状态更新协议尚未迁入。当前路由不增加 Run/State 并发锁或时序保证。

## SSE 与下载例外

- SSE 成功返回原始 `text/event-stream`，只有 event/data 帧，不套 JSON 包络；连接生命周期见 [会话事件](server-v2-events.md)。
- SSE 的 HEAD 只返回响应头，不建立订阅、心跳或事件流。
- 文件成功返回原始字节流，保留 MIME、长度和原件 attachment 下载头；HEAD 返回响应头且释放已打开资源。
- SSE 握手或文件打开之前的失败仍是普通 HTTP JSON 失败包络；传输已经开始后不把流改成 JSON 包络。

## 验证

运行本包 `test`、`typecheck`、`lint`。业务路由使用真实 Service/临时 SQLite 验证；网络测试使用真实回环端口验证 SSE、重启与关闭，文件测试验证实际字节及句柄释放。架构 lint 覆盖模块唯一出口、反向依赖、跨层存储访问、连接生命周期和 SQL 属主。
