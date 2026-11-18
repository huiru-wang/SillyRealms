# Server V2 HTTP 契约

## 调用边界

HTTP适配器位于 `apps/serverV2/src/routes/`，可调用业务模块Service或应用usecase的读写能力。单域操作直接调用Service，跨模块写编排及导入导出流程交给usecases；跨模块只读展示投影可在route组合。业务模块位于modules/<name>，唯一出口是service.ts，Repository 及 parser/validation/assets/archive/files、预设 card/default 等内部实现私有。Service跨模块只依赖Reader只读能力；usecase不写SQL，只借用绑定到共享连接的同步事务能力，Repository保留本域必要原子性。

Service 公共输入输出采用显式驼峰领域类型，存储行到领域对象的转换位于 Service，存储行及列名留在模块内部。HTTP 使用 V2 管理接口契约；跨模块展示字段由 route 调属主 Service 组合，不放回 Repository JOIN 或相互依赖的 Service 展示逻辑。作者 JSON、状态键及文档协议里的键不做递归改名。

业务接口统一前缀为 `/api/v1`。以下路径均省略此前缀，健康检查 `GET /health` 除外。V2 使用独立数据库；StudioV2 接入世界内容库、预设、模型配置、设置和基础会话，旧 Server/Studio 保持独立。数据库 user_version=3，只迁移结构匹配的 V2 v1/v2 库（v2 添加预设 revision，v3 添加世界 revision 和 created_at/id 索引），拒绝未知结构和旧 Server 库。createApp传入services时必须同时传入usecases；server在监听HTTP前执行initialize，业务播种不在openDatabase内。

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

- 单项读取、创建及更新的 data 为 `{ item }`，包括会话详情和预设默认模板；删除为 `{ id }`。
- 世界、预设、模型、会话列表返回 `{ items, hasMore, nextCursor }`；标签、条目和线性历史返回 `{ items }`。
- 创建返回 201，普通成功返回 200。删除也返回 200 包络，不使用无正文的 204。
- 健康检查返回成功包络，data 为 `{ ok: true }`。
- 失败保留正确的 HTTP 4xx/5xx 状态，不用 200 表示失败。
- 错误码、中文描述及 HTTP 状态统一定义在 `src/errors.ts`。可公开的参数详情并入 errorMessage，不新增 detail/error 等字段。
- 未知异常统一为 INTERNAL_ERROR/500，不暴露原始 SQL、路径、堆栈或回调异常内容。

普通JSON写入请求使用 `Content-Type: application/json`（也接受 application/*+json），正文必须是 JSON 对象。普通结构字段使用 Service 的 camelCase 命名。世界卡 data 及预设导入导出文件保留各自文档协议；预设 CRUD 使用领域配置结构。业务校验由 Service 完成。

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
| 世界管理版本已过期 | 409 | WORLD_REVISION_CONFLICT |
| 请求来源不被允许 | 403 | ORIGIN_NOT_ALLOWED |
| 世界卡或资源包无效 | 422 | INVALID_WORLD_CARD、INVALID_WORLD_PACKAGE |
| 上传内容超过限制 | 413 | PAYLOAD_TOO_LARGE |
| 世界文件清理失败，可重试同一删除请求 | 500 | WORLD_FILES_DELETE_FAILED |
| 世界导入、导入清理或导出失败 | 500 | WORLD_IMPORT_FAILED、WORLD_IMPORT_CLEANUP_FAILED、WORLD_EXPORT_FAILED |
| 未知异常 | 500 | INTERNAL_ERROR |

## 预设、模型与默认设置

| 方法 | 路径 | 能力 |
|---|---|---|
| GET / POST | /presets | 预设列表 / 创建 |
| GET | /presets/default | 读取默认预设文档，不写数据库 |
| POST | /presets/import | 导入预设JSON文档，同名自动选择可用名称 |
| GET / HEAD | /presets/:id/export | 当前预设JSON附件 / 下载头 |
| GET / PATCH / DELETE | /presets/:id | 预设读取 / 修改 / 删除 |
| GET / POST | /api-model-configs | 模型配置列表 / 创建 |
| GET / PATCH / DELETE | /api-model-configs/:id | 模型配置读取 / 修改 / 删除 |
| GET / PATCH | /app-settings | 读取 / 更新应用默认预设、模型 |

预设列表支持 type、limit、cursor；模型配置列表支持 limit、cursor，也保留显式 offset 分页。cursor 与 offset 不能同时使用；游标绑定对应资源及筛选条件，不能挪到其他查询。Service 只接收类型化分页参数，HTTP 负责游标编码。

预设详情返回 `{id,revision,type,name,description,config,createdAt,updatedAt}`；列表仅返回去掉 config 的摘要，不读取每个预设的配置正文。当前只支持 type=narrative；config 为 `{schemaVersion:1,nodes,contextStrategy,modelParameters}`。CRUD 不再接受 config_json/context_strategy/model_parameters 顶层字段。

创建接收 `{name,description,type,config}`（可提供 id）。PATCH 接收修改字段及必填 expectedRevision，成功后 revision 加一；版本过期返回 PRESET_REVISION_CONFLICT/409，保持服务端内容不变。温度可省略，表示未指定；summaryPrompt 只有 rolling_summary 策略要求非空。

默认模板接口返回 `data.item`，没有 ID/revision，不创建持久化记录。导入仍接收便携文档 `{name,description,config_json:{schemaVersion:3,nodes},context_strategy,model_parameters}`，导入成功返回领域详情。导出使用同一便携文档协议，当前名称加 .json，排除 ID、revision、时间戳；GET/HEAD 下载成功不套包络。文件协议转换属于 presets 模块，不影响 CRUD 配置结构。

模型创建接收 `{name,providerId,modelId,apiKey}`，ID 由服务端生成；PATCH 接收上述字段的非空子集，省略 apiKey 保留原值，更换 providerId 必须同时提供新 apiKey。客户端不能传 credentialRef。响应为 `{id,name,providerId,modelId,credentialStatus,createdAt,updatedAt}`，不返回密钥或引用。credentialStatus 为 configured（凭据存在）、missing（未保存或不属于当前存储）、unavailable（存储不可访问），不代表已验证模型调用。无 catalog 或连接测试接口。

凭据由独立 credentials 模块保存，默认适配 macOS Keychain，引用按 V2 dataRoot 隔离，数据库只存引用。其他平台默认返回存储不可用，可由启动装配注入 CredentialStore。模型用例协调凭据和配置：写入数据库失败时补偿凭据；删除先检查数据库引用并删记录，再删凭据。凭据清理失败返回 CREDENTIAL_DELETE_FAILED/503，可重试相同 DELETE；补偿失败返回 CREDENTIAL_COMPENSATION_FAILED/500。跨资源流程不是数据库强事务，未提供进程崩溃恢复保证。

默认设置为 `{defaultPresetId,defaultApiModelConfigId}`。PATCH 只更新提交字段，显式 null 清除默认，不存在的引用由属主 Service 报错。默认值在世界导入时复制一次，不批量覆盖已有世界或会话。被默认设置、世界或会话引用的预设/模型不能直接删除。

## 世界与文件

| 方法 | 路径 | 能力 |
|---|---|---|
| GET | /worlds | 摘要列表，名称和标签筛选 |
| POST | /worlds/import | multipart file 字段上传 JSON 或 ZIP 世界卡 |
| GET / HEAD | /worlds/:id/export | 按当前世界重建 ZIP / 下载头 |
| GET / PATCH / DELETE | /worlds/:id | 领域详情 / 管理字段修改 / 受限删除 |
| GET | /worlds/tags | 已绑定标签 `{name,worldCount}` |
| GET | /worlds/:id/components | 已解析组件源码及按组件 ID 返回的错误 |
| GET / HEAD | /worlds/:id/original | 下载或检查已保存原件 |
| GET / HEAD | /worlds/:id/resources/* | 读取或检查包内组件、素材等资源 |

世界列表支持 q（名称包含匹配，最多 200 字符）、tag（精确标签名）、limit（1–200，默认 24）、cursor；不接受 offset/tagId。按 createdAt/id 倒序进行 keyset 分页，编辑内容或状态不改变顺序。游标绑定名称及标签筛选，不能挪到其他查询。Repository 直接读取摘要列并批量读取本页标签，不解析作者 JSON；sessionCount 由 route 调 SessionService 批量组合，不跨模块 JOIN。

列表项为 `{id,name,cover,tags:string[],sessionCount,createdAt,updatedAt}`。详情为 `data.item`，顶层字段包括 id、revision、specVersion、name、description、cover、tags、characters、openings、lorebook、stateDefinition、messageRender、components、stageComponent、extensions、defaultPresetId、defaultApiModelConfigId、createdAt、updatedAt。不再包装 item.data 或返回空 warnings；stateDefinition 是作者声明，详情不包含运行 state。description 保留 null、组件对象或已有文本；作者对象内部协议键不递归转换。

PATCH 仅接受 name、tags、defaultPresetId、defaultApiModelConfigId 的非空子集，以及必填 expectedRevision。只写提交的管理列；标签 trim、去重并保留顺序，与 revision 更新在同一事务中完成。成功 revision 加一；过期返回 WORLD_REVISION_CONFLICT/409，引用不存在或校验失败不部分保存。显式 null 清除默认配置。不提供 POST /worlds、PUT /worlds/:id/tags 或旧 /tags 别名；作者内容与运行状态不通过管理 PATCH 更新。

`/components` 返回 `data:{items:[{id,component}],errors:Record<string,string>}`。path 声明优先于 inline，文件读取失败不回退；路径、编码和大小检查由 worlds 内部复用，单个组件错误不阻塞其他组件读取，错误不暴露绝对磁盘路径。前端按需编译，接口不执行作者代码。

资源接口 `/worlds/:id/resources/*` 的通配路径相对于磁盘 `package/` 根目录，例如 `resources/assets/cover.png`、`resources/components/intro.tsx`；保留读取包内文件的范围，不限于素材目录。HTTP 路径命名不改变磁盘布局或现有路径安全规则。

原件下载固定文件名为 `original.json` 或 `original.zip`，反映已保存的原始字节。包资源路径允许子目录，拒绝路径穿越和符号链接；资源响应包含 MIME、nosniff、只读文档 CSP 和 Access-Control-Allow-Origin: *；文件打开和流生命周期在世界模块内部处理。

删除世界先执行 DB 删除，外键仍拒绝被会话引用的世界；拒绝时文件不动。删除成功后清理整个世界根目录，包括 source/ 和 package/。目录缺失视为已清理；DB 已不存在但目录残留时，重试同一 DELETE 仍会清理并返回成功。两者均不存在返回 WORLD_NOT_FOUND。

文件清理失败返回 WORLD_FILES_DELETE_FAILED，不回滚已完成的 DB 删除；调用方可重试。文件写入/删除按世界串行，并拒绝不安全的世界根目录；不会跟随内部符号链接删除外部目标。

世界模块内部职责：`parser.ts` 解码 JSON、调用统一校验并转换卡片与领域对象；`validation.ts` 校验卡结构、引用、状态与条件表达式；`assets.ts` 读取组件源码并检查资源引用；`archive.ts` 处理导入文件、ZIP 解压和导出打包；`files.ts` 管理目录、暂存、发布、清理和文件流。条件表达式只做静态验证，不执行。上述实现通过 `service.ts` 对外提供能力，不改变本节 HTTP 和磁盘布局契约。

世界导入采用multipart/form-data，HTTP 层按实际字节限制读取正文流并保留 boundary，不依赖 Node 适配器 Request 对象具有原生 Fetch 内部状态。只接受一个file字段，扩展名为.json或.zip。上传原名只用于判断格式，不保存、不参与导出命名；保留上传原始字节。ZIP根目录为world.json，资源只能位于components/和assets/，允许子目录；验证重复/冲突路径、符号链接、大小、资源引用和世界卡内容。JSON导入不能引用不存在的包内资源。卡使用spec_version和data，不再要求固定spec标识，导出也不生成spec。

导入由用例读取应用默认预设/模型引用，调用WorldService暂存、校验、发布文件并写入世界及标签；失败清理本次操作产生的数据和文件。数据库事务不包围异步文件操作；清理失败显式返回WORLD_IMPORT_CLEANUP_FAILED。

当前世界导出从DB读取世界卡与标签，结合package/当前资源重新构建ZIP，忽略原始上传字节与package中旧world.json。文件名为当前world.name.zip，非法文件名字符做安全替换，中文使用标准下载头编码；导出使用no-store。导出产物先完整生成，再打开下载流，完成/取消/HEAD后清理临时文件。

导出会重新校验当前内容能否表示为合法0.1世界卡。已有纯文本 description 无法表示为协议要求的组件描述时，明确返回INVALID_WORLD_CARD/422，不静默丢弃该字段。

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

会话列表支持 worldId、limit、cursor，不提供关键词搜索。route 解析游标位置后调用 SessionService；列表项的 worldName/cover 通过 WorldService 在 route 组合，同一请求缓存重复世界读取。SessionService 只返回自身的 Session 领域对象。条目列表支持 afterSeq、limit。整数 query 必须是合法安全整数，再由 Service 校验允许范围。

会话详情 GET 返回 `data.item: SessionView`，包含 worldId、presetId、apiModelConfigId、userCharacterId、tipEntryId、title 等驼峰字段。创建接收 worldId/presetId/apiModelConfigId/userCharacterId，可带 id/title；玩家角色必须属于该世界且 player_selectable=true，否则返回 INVALID_SESSION_CHARACTER/422。创建只保存基础记录，不初始化开场、消息或执行任务。PATCH 仅支持 title/presetId/apiModelConfigId，世界与玩家身份创建后不再修改。StudioV2 不挂载 SessionHost，不请求本节的条目、历史、Run 或 SSE 接口。

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

状态读取与前驱继承留在StateService，PUT经set-state用例调用属主World/Session Service。世界卡导入仅做状态定义的静态校验；状态规则执行、按路径PATCH和模型输出状态更新协议尚未迁入。当前 scope GET/PUT 与旧 SDK 的聚合 state.read/path PATCH 是不同契约，不能把此次字段适配理解为 Studio 已完整切换 V2。当前路由不增加 Run/State 并发锁或时序保证。

## SSE 与下载例外

- SSE 成功返回原始 `text/event-stream`，只有 event/data 帧，不套 JSON 包络；连接生命周期见 [会话事件](server-v2-events.md)。
- SSE 的 HEAD 只返回响应头，不建立订阅、心跳或事件流。
- 文件成功返回原始字节流，保留MIME、长度和attachment下载头；HEAD 返回响应头且释放已打开资源。
- SSE 握手或文件打开之前的失败仍是普通 HTTP JSON 失败包络；传输已经开始后不把流改成 JSON 包络。

## Studio 来源与作者预览

普通 `/api/*` 请求带 Origin 时，只接受服务自身来源或配置的 Studio 来源；默认 Studio 为 `http://127.0.0.1:5176`，启动参数为 `studioOrigin` / `SERVER_V2_STUDIO_ORIGIN`。不带 Origin 的进程内/命令行调用仍可用；Origin 校验不代替身份认证。未授权来源和 null 来源的业务请求返回 ORIGIN_NOT_ALLOWED/403。

跨来源只放行 `/api/v1/worlds/:id/resources/*` 的 GET/HEAD，不放行世界详情、状态或写入。作者预览由独立静态来源承载，无 API 代理；宿主的只读 bridge 获取状态后仅投影请求的 global 路径。预览部署约束见 [StudioV2 管理](studio-v2-management.md)。

## 验证

函数验证使用内存或临时 SQLite、临时文件和最小 CredentialStore 替身，不访问真实凭据。配合 `typecheck`、`lint` 检查接口和边界。本次 StudioV2 接入不启动服务、不执行已有 HTTP/网络或浏览器链路测试；这些测试保留在仓库供后续单独运行。架构lint覆盖modules属主、模块唯一出口、Reader依赖、usecases边界、跨层存储访问和SQL属主；类型检查验证Reader不可调用写方法及事务不能接受异步回调。
