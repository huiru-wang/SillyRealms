# Server V2 HTTP 契约

## 调用边界

HTTP 适配器位于 `apps/serverV2/src/routes/`，只调用业务模块的 `service.ts`。业务模块唯一公开出口是 Service；Repository 模块内私有且只能访问本模块属主数据。Service 不持有连接或开启事务；启动装配方管理连接生命周期，Repository 只保留本模块必要的原子写入。

Service 公共输入输出采用显式驼峰领域类型，存储行到领域对象的转换位于 Service，存储行及列名留在模块内部。HTTP 根据 Studio 当前消费契约投影；跨模块展示字段由 route 调属主 Service 组合，不放回 Repository JOIN 或相互依赖的 Service 展示逻辑。作者 JSON、状态键及文档协议里的键不做递归改名。

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

- 一般单项读取、创建及更新的 data 为 `{ item }`；删除为 `{ id }`。会话详情 GET 按 Studio SessionHost 契约直接返回 `data: SessionView`，会话创建仍返回 `{ item }`。
- 世界、预设、模型、会话列表返回 `{ items, hasMore, nextCursor }`；标签、条目和线性历史返回 `{ items }`。
- 创建返回 201，普通成功返回 200。删除也返回 200 包络，不使用无正文的 204。
- 健康检查返回成功包络，data 为 `{ ok: true }`。
- 失败保留正确的 HTTP 4xx/5xx 状态，不用 200 表示失败。
- 错误码、中文描述及 HTTP 状态统一定义在 `src/errors.ts`。可公开的参数详情并入 errorMessage，不新增 detail/error 等字段。
- 未知异常统一为 INTERNAL_ERROR/500，不暴露原始 SQL、路径、堆栈或回调异常内容。

JSON 写入请求使用 `Content-Type: application/json`（也接受 application/*+json），正文必须是 JSON 对象。普通结构字段使用 Service 的 camelCase 命名。预设 HTTP 文档和世界卡 data 保留现有 Studio 协议字段，由 route 显式适配；业务校验由 Service 完成。

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
| 世界文件清理失败，可重试同一删除请求 | 500 | WORLD_FILES_DELETE_FAILED |
| 未知异常 | 500 | INTERNAL_ERROR |

## 预设、模型与默认设置

| 方法 | 路径 | 能力 |
|---|---|---|
| GET / POST | /presets | 预设列表 / 创建 |
| GET / PATCH / DELETE | /presets/:id | 预设读取 / 修改 / 删除 |
| GET / POST | /api-model-configs | 模型配置列表 / 创建 |
| GET / PATCH / DELETE | /api-model-configs/:id | 模型配置读取 / 修改 / 删除 |
| GET / PATCH | /app-settings | 读取 / 更新应用默认预设、模型 |

预设列表支持 type、limit、cursor；模型配置列表支持 limit、cursor，也保留显式 offset 分页。cursor 与 offset 不能同时使用；游标绑定对应资源及筛选条件，不能挪到其他查询。Service 只接收类型化分页参数，HTTP 负责游标编码。

预设 Service 返回 `{id,type,name,description,config,createdAt,updatedAt}`；config 使用 schemaVersion/contextStrategy/modelParameters。HTTP 按 Studio 编辑器文档输出 `config_json: {schemaVersion:3,nodes}`、`context_strategy`、`model_parameters`，写入时反向转换，严格拒绝未知字段。该文档版本不改变 V2 存储 config_json 的 schema_version=1。

模型 Service 使用 providerId/modelId/credentialRef；HTTP 隐去 credentialRef，创建/更新当前支持显式凭据引用。V2 尚无凭据存储/探测能力，响应不会用引用存在冒充 credentialConfigured。默认设置输入输出为 defaultPresetId/defaultApiModelConfigId；显式 null 清除引用，不存在的引用由属主 Service 报错。

## 世界与文件

| 方法 | 路径 | 能力 |
|---|---|---|
| GET / POST | /worlds | 世界列表 / 创建 |
| GET / PATCH / DELETE | /worlds/:id | 世界读取 / 修改 / 删除 |
| GET | /worlds/tags、/tags?type=world | 已绑定的世界标签目录 |
| PUT | /worlds/:id/tags | 替换一个世界的标签，正文必须且只能是 `{ "tags": [...] }` |
| GET / HEAD | /worlds/:id/original | 下载或检查已保存原件 |
| GET / HEAD | /worlds/:id/package/* | 读取或检查包内组件、素材等资源 |

世界列表支持 tagId、limit、cursor，也保留 offset。列表项按 Studio 返回 `{id,name,cover,tags,sessionCount}` 等元数据；tags 项为 `{id:name,name}`，tagId 使用标签名。sessionCount 在 route 通过 SessionService 批量统计后组合，WorldService 不依赖 SessionService。

世界 Service 返回 specVersion、characters、openings、lorebook、stateDefinition、messageRender、stageComponent、extensions、defaultPresetId/defaultApiModelConfigId 和驼峰时间字段等领域值。详情 HTTP 返回 `{item:{id,data,defaultPresetId,defaultApiModelConfigId,...}}`；data 使用世界卡协议，state 对应状态定义，stage_component/message_render 等协议键保留原样。组件形式的 description 以对象传输，存储编码不泄露到返回值。

普通世界创建/更新使用驼峰字段，内容更新不接收运行 state；状态通过下述作用域接口写入。

原件下载固定文件名为 `original.json` 或 `original.zip`，反映已保存的原始字节。包资源路径允许子目录，拒绝路径穿越和符号链接；文件打开和流生命周期在世界模块内部处理。

删除世界先执行 DB 删除，外键仍拒绝被会话引用的世界；拒绝时文件不动。删除成功后清理整个世界根目录，包括 source/ 和 package/。目录缺失视为已清理；DB 已不存在但目录残留时，重试同一 DELETE 仍会清理并返回成功。两者均不存在返回 WORLD_NOT_FOUND。

文件清理失败返回 WORLD_FILES_DELETE_FAILED，不回滚已完成的 DB 删除；调用方可重试。文件写入/删除按世界串行，并拒绝不安全的世界根目录；不会跟随内部符号链接删除外部目标。

上述下载不等于重新生成世界 ZIP。以当前 DB 世界卡、标签和 package/ 资源构建 `world_name.zip` 的完整导出、ZIP 导入及上传用例仍待后续实施。

## 会话、消息与线性历史

| 方法 | 路径 | 能力 |
|---|---|---|
| GET / POST | /sessions | 会话列表 / 创建 |
| GET / PATCH / DELETE | /sessions/:id | 会话读取 / 修改 / 删除 |
| GET / POST | /sessions/:id/entries | 消息/摘要列表 / 追加 |
| GET / PATCH | /sessions/:id/entries/:entryId | 单条读取 / 正文或 extData 更新 |
| GET | /sessions/:id/history | 当前完整线性历史 |
| GET | /sessions/:id/runs/:runId/entries | 按 runId 分组读取条目 |
| GET / HEAD | /sessions/:id/events | SSE 事件连接 / 仅检查响应头 |

会话列表支持 worldId、limit、cursor。route 解析游标位置后调用 SessionService；列表项的 worldName/cover 通过 WorldService 在 route 组合，同一请求缓存重复世界读取。SessionService 只返回自身的 Session 领域对象。条目列表支持 afterSeq、limit。整数 query 必须是合法安全整数，再由 Service 校验允许范围。

会话详情 GET 的 data 直接是 SessionView，包含 worldId、presetId、apiModelConfigId、userCharacterId、tipEntryId、title 等驼峰字段。创建仍接收明确的 worldId/presetId/apiModelConfigId/userCharacterId，返回 `{item}`；按 openingId 继承配置及初始化开场的用例尚未迁入。

本期只做线性追加。parentId 可省略，默认当前 tip；显式值不匹配时返回 TIP_CONFLICT。新条目、seq 与 tip 的原子更新归 SessionRepository；没有 setTip 或分支切换接口。

SessionEntry 使用 sessionId、parentId、runId、extData、metrics、createdAt/updatedAt，payload 与状态内容保持原键。HTTP 追加条目不接受 metrics，也不提供编辑计量的 HTTP 路由；计量由进程内 SessionService 写入。runId 只用于条目分组，本期没有 Run 执行路由。

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

状态规则解释、按路径 PATCH 和模型输出状态更新协议尚未迁入。当前 scope GET/PUT 与旧 SDK 的聚合 state.read/path PATCH 是不同契约，不能把此次字段适配理解为 Studio 已完整切换 V2。当前路由不增加 Run/State 并发锁或时序保证。

## SSE 与下载例外

- SSE 成功返回原始 `text/event-stream`，只有 event/data 帧，不套 JSON 包络；连接生命周期见 [会话事件](server-v2-events.md)。
- SSE 的 HEAD 只返回响应头，不建立订阅、心跳或事件流。
- 文件成功返回原始字节流，保留 MIME、长度和原件 attachment 下载头；HEAD 返回响应头且释放已打开资源。
- SSE 握手或文件打开之前的失败仍是普通 HTTP JSON 失败包络；传输已经开始后不把流改成 JSON 包络。

## 验证

运行本包 `test`、`typecheck`、`lint`。业务路由使用真实 Service/临时 SQLite 验证；网络测试使用真实回环端口验证 SSE、重启与关闭，文件测试验证实际字节及句柄释放。架构 lint 覆盖模块唯一出口、反向依赖、跨层存储访问、连接生命周期和 SQL 属主。
