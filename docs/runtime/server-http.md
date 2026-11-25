# Server HTTP 契约

## 调用边界

HTTP适配器位于 `apps/server/src/routes/`，可调用业务模块Service或应用usecase的读写能力。单域操作直接调用Service，跨模块写编排及导入导出流程交给usecases；跨模块只读展示投影可在route组合。业务模块位于modules/<name>，唯一出口是service.ts，Repository 及 parser/validation/assets/archive/files、预设 card/default 等内部实现私有。Service跨模块只依赖Reader只读能力；usecase不写SQL，需要事务的用例只接收绑定到共享连接的同步事务能力，Repository保留本域必要原子性。叙事用例不接收事务能力，用户与助手分别保存。

数据库连接与结构、EventHub/SSE、pi 模型适配分别位于 `src/infrastructure/database/`、`src/infrastructure/events/`、`src/infrastructure/pi/`。叙事生命周期位于 `src/usecases/narrative/`，不进入 transport 或基础设施；pi 适配不读写业务存储、不发布业务事件。

Service 公共输入输出采用显式驼峰领域类型，存储行到领域对象的转换位于 Service，存储行及列名留在模块内部。HTTP 使用 V2 管理接口契约；跨模块展示字段由 route 调属主 Service 组合，不放回 Repository JOIN 或相互依赖的 Service 展示逻辑。作者 JSON、状态键及文档协议里的键不做递归改名。

业务接口统一前缀为 `/api/v1`。以下路径均省略此前缀，健康检查 `GET /health` 除外。V2 使用独立数据库；Web 接入世界内容库、预设、模型配置、设置和基础会话和叙事运行页。数据库 user_version=11，只迁移结构匹配的 V2 v1–v10 库（v2 添加预设 revision，v3 添加世界 revision 和 created_at/id 索引，v4 为非 NULL 消息状态添加 (session_id,seq) 索引，v5 添加带 zh-CN 默认值的 app_settings.locale，v6 在同一迁移事务内重建该单例表的 CHECK 约束以接受 ja，逐字段保留默认项、原语言及时间戳，v7 添加帮答模型绑定、应用默认帮答预设和会话帮答目标，v8 添加可空的 sessions.reply_assist_preset_id，v9 重建 sessions，清空旧会话及其 entries，保留世界、模型、预设和应用设置；v10 仅为 app_settings 添加 cover_mosaic_density，保留 v9 的全部数据；v11 仅为 worlds 添加可空的 default_reply_assist_preset_id，保留 v10 全部数据），拒绝未知结构和旧 Server 库。createApp传入services时必须同时传入usecases；server在每次监听HTTP前执行initialize，业务播种不在openDatabase内。initialize 在同一同步事务中调用 presets.ensureBuiltins 和 settings.ensure，缺失时恢复稳定 ID 为 sr-default-preset 和 sr-default-reply-assist-preset 的内置预设并补齐设置记录。已存在的预设内容、revision、时间戳和设置（包括自定义默认项、显式 null）不覆盖；同名自定义预设不覆盖，恢复项采用名称避重。默认模型保持 null，不创建模型或凭据；不需要前端向导。

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

- 常规单项读取、创建及更新的 data 为 `{ item }`，包括会话详情和预设默认模板；删除为 `{ id }`。立绘目录与指定消息查询使用各自明确的 data 结构，见[立绘查询](#立绘查询)。
- 世界、预设、模型、会话列表返回 `{ items, hasMore, nextCursor }`；标签、条目和线性历史返回 `{ items }`。
- 资源创建返回 201，叙事受理返回 202，普通成功返回 200。删除也返回 200 包络，不使用无正文的 204。
- 健康检查返回成功包络，data 为 `{ ok: true }`。
- 失败保留正确的 HTTP 4xx/5xx 状态，不用 200 表示失败。
- 错误码、中文描述及 HTTP 状态统一定义在 `src/errors.ts`。可公开的参数详情并入 errorMessage，不新增 detail/error 等字段。
- 未知异常统一为 INTERNAL_ERROR/500，不暴露原始 SQL、路径、堆栈或回调异常内容。

普通JSON写入请求使用 `Content-Type: application/json`（也接受 application/*+json），正文必须是 JSON 对象。普通结构字段使用 Service 的 camelCase 命名。世界卡 data 及预设导入导出文件保留各自文档协议；预设 CRUD 使用领域配置结构。业务校验由对应 Service 或用例完成。叙事 stop 与模型 test 不要求请求正文。

| 情况 | HTTP | 常用 errorCode |
|---|---|---|
| JSON 格式无效 | 400 | INVALID_JSON |
| 字段、类型或分页参数无效 | 400 | INVALID_REQUEST 或对应已注册业务校验码 |
| Content-Type 不支持 | 415 | UNSUPPORTED_MEDIA_TYPE |
| 预设、模型、世界、会话或消息不存在 | 404 | PRESET_NOT_FOUND、MODEL_CONFIG_NOT_FOUND、WORLD_NOT_FOUND、SESSION_NOT_FOUND、ENTRY_NOT_FOUND |
| 资源重复 | 409 | RESOURCE_CONFLICT |
| 被引用的数据不能删除或关联数据已变化 | 409 | REFERENCE_CONFLICT |
| 世界存在关联会话，需确认一并删除 | 409 | WORLD_HAS_SESSIONS |
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
| GET | /presets/default | 读取发行清单指定的默认模板，返回预设领域对象，不写数据库 |
| POST | /presets/import | 导入预设JSON文档，同名自动选择可用名称 |
| GET / HEAD | /presets/:id/export | 当前预设JSON附件 / 下载头 |
| GET / PATCH / DELETE | /presets/:id | 预设读取 / 修改 / 删除 |
| GET / POST | /api-model-configs | 模型配置列表 / 创建 |
| GET / PATCH / DELETE | /api-model-configs/:id | 模型配置读取 / 修改 / 删除 |
| POST | /api-model-configs/:id/test | 使用已保存配置执行一次短文本连通性检测 |
| GET | /providers/models | 按 provider 分组的 pi 静态模型目录、能力参数与消息顺序兼容性 |
| GET / PATCH | /app-settings | 读取 / 更新应用默认预设、模型、语言和封面马赛克密度 |


应用语言由 `AppSettings.locale` 保存，只接受 `zh-CN`、`en` 和 `ja`，新安装及无语言字段的旧库默认 `zh-CN`，已有语言值在升级时保持不变。GET 返回 `data.item.locale`；PATCH `{"locale":"en"}` 只更新语言，未提交的默认预设/模型保持原值，其他字段更新也不重置语言。不接受 null、空字符串或未知语言。设置为应用实例共享值；切换成功后开始的新请求使用新语言，已捕获上下文的运行继续使用原语言。叙事提交/重新生成不新增 locale 请求字段。

`AppSettings.coverMosaicDensity` 为 8–64 的整数，默认 24，表示列表封面短边的采样格数。PATCH 只更新提交的值，拒绝 null、小数和越界值；保存语言或默认项不重置密度。密度为应用实例设置，不随世界卡导出。

删除预设时如仍有引用，返回 409 `REFERENCE_CONFLICT`。响应的 `errorMessage` 列出实际引用该预设的应用默认设置、世界卡名称及会话标题。同名记录和未命名会话附带 ID。

预设列表支持 type、limit、cursor；模型配置列表支持 limit、cursor，也保留显式 offset 分页。cursor 与 offset 不能同时使用；游标绑定对应资源及筛选条件，不能挪到其他查询。Service 只接收类型化分页参数，HTTP 负责游标编码。

预设详情返回 `{id,revision,type,name,description,config,createdAt,updatedAt}`；列表仅返回去掉 config 的摘要，不读取每个预设的配置正文。类型支持 `narrative` 与 `reply_assist`，创建后固定。列表和默认模板的 type 查询参数默认 narrative。帮答详情另含本机模型绑定 `apiModelConfigId`（可空）。config 为 `{schemaVersion:1,nodes,contextStrategy,modelParameters}`。CRUD 不再接受 config_json/context_strategy/model_parameters 顶层字段。

modelParameters 包含可选有限数值 temperature（0–2）、topP（0–1）、frequencyPenalty 与 presencePenalty（各 −2–2），以及 thinkingEnabled 开关及可选 thinkingLevel（minimal、low、medium、high、xhigh、max）。思考深度不指定时保留默认行为；关闭思考或模型不支持思考时不传思考参数。模型支持思考但不支持所选深度时，仅忽略该深度选择并沿用既有默认深度，保持思考开关语义。便携文档及内部存储分别对应 model_parameters.thinking_enabled / thinking_level，旧记录缺少深度时无需迁移。

采样区间包含端点。省略键表示使用模型默认，显式 0 是有效值。便携文件与 SQLite JSON 的 model_parameters 使用 temperature、top_p、frequency_penalty、presence_penalty；旧记录及文件省略新增项即可读取。保存完整 config 时移除对应键即可恢复默认。

创建接收 `{name,description,type,config}`（可提供 id）。PATCH 接收修改字段及必填 expectedRevision，成功后 revision 加一；版本过期返回 PRESET_REVISION_CONFLICT/409，保持服务端内容不变。温度可省略，表示未指定；summaryPrompt 只有 rolling_summary 策略要求非空。

叙事预设中的 worldState 是 worldInfo 与 chatHistory 之间必需的 system 节点。{{state.update.message}} 仅可在 stateUpdate 中引用。能力节点按 stateUpdate → actionSuggestions → characterSprite 的相对顺序保存；节点可缺失或关闭。启用能力节点必须有非空 prompt，禁止引用 input.text/history.messages/history.summary；不在读取时补节点、补默认提示词或转换 state.entries。正式变量包含 {{characterSprite.catalog}}，启用及素材条件见 [预设创作](../creator/presets-and-models.md)。

默认模板接口返回 `data.item`，没有 ID/revision，不创建持久化记录。导入接收便携文档 `{type,name,description,config_json:{schemaVersion:3,nodes},context_strategy,model_parameters}`，旧文件缺少 type 时按 narrative 解释。帮答文件使用 sliding_window、输入与输出预算，省略 summary_prompt。模型绑定不随文件传输，导入后为 null。导入成功返回领域详情。导出使用同一便携文档协议，当前名称加 .json，排除 ID、revision、时间戳；GET/HEAD 下载成功不套包络。文件协议转换属于 presets 模块，不影响 CRUD 配置结构。

模型创建接收 `{name,providerId,modelId,apiKey}`，ID 由服务端生成；PATCH 接收上述字段的非空子集，省略 apiKey 保留原值，更换 providerId 必须同时提供新 apiKey。客户端不能传 credentialRef。响应为 `{id,name,providerId,modelId,credentialStatus,createdAt,updatedAt}`，不返回密钥或引用。credentialStatus 为 configured（凭据存在）、missing（未保存或不属于当前存储）、unavailable（存储不可访问），不代表已验证模型调用。

`GET /providers/models` 返回 `data.items: ProviderModelGroup[]`，每组为 `{providerId,name,models: ModelInfo[]}`，来自固定版本 pi 的内置聊天模型目录，不平铺 provider 与模型，也不保存到模型配置表。前端先选 provider，再从该组 models 选择模型。

| ModelInfo 字段 | 含义 |
| --- | --- |
| providerId、modelId、name | 服务商 ID、模型 ID 与目录名称 |
| contextWindow、maxTokens | 上下文窗口与模型最大输出 tokens |
| reasoning | 是否为推理模型 |
| thinkingLevelMap | SDK 原始档位映射或 null；映射中的 null 表示该档不支持，缺少键可能使用 SDK 默认 |
| thinkingLevels | 由 SDK getSupportedThinkingLevels(model) 计算的有效档位；非推理模型只有 off，客户端不复制推导规则 |
| api | 模型所用协议标识 |
| input | 支持的输入模态列表 |
| promptCache | SDK 缓存元信息 `{short:number|null,long:number|null}` 或 null，单位秒；缺少某档时该档为 null |
| narrativeCompatible、supportsMidConversationSystemMessages | 是否可保持叙事编排中的中途 system 消息顺序 |

promptCache 是 SDK 提供的最佳估计保留时长，缺失表示未提供，不等于不支持；它与请求 cacheRetention 偏好不同，返回长档时长不表示当前调用已启用长档，也不保证供应商实际保留期限。本次只展示目录能力，不修改生成或缓存请求配置。接口不返回 SDK baseUrl、headers、凭据或原始模型对象。

`narrativeCompatible` 为 false 的模型，在实际编译结果没有中途 system 消息时仍可调用。未知模型不会自动替换。

`POST /api-model-configs/:id/test` 只读取已保存模型配置及其凭据，发起一次短文本调用，传给 pi 的 maxTokens 为 min(64, model.maxTokens)，整体等待上限 30 秒，不自动重试。成功返回 `data:{connected:true,providerId,modelId,durationMs,usage}`；usage 为标准 token 字段或 null。失败使用普通错误包络，不返回 `connected:false`、供应商原文、模型回复或凭据引用。此接口不创建会话、entry 或 run，也不修改 credentialStatus；检测成功不保证任意叙事消息顺序都兼容。

凭据由独立 credentials 模块保存，默认适配 macOS Keychain，引用按 V2 dataRoot 隔离，数据库只存引用。其他平台默认返回存储不可用，可由启动装配注入 CredentialStore。模型用例协调凭据和配置：写入数据库失败时补偿凭据；删除先检查数据库引用并删记录，再删凭据。凭据清理失败返回 CREDENTIAL_DELETE_FAILED/503，可重试相同 DELETE；补偿失败返回 CREDENTIAL_COMPENSATION_FAILED/500。跨资源流程不是数据库强事务，未提供进程崩溃恢复保证。

默认设置为 `{defaultPresetId,defaultApiModelConfigId,defaultReplyAssistPresetId}`。PATCH 只更新提交字段，显式 null 清除默认，不存在的引用由属主 Service 报错。叙事预设、帮答预设和模型默认值在世界导入时复制一次，不批量覆盖已有世界或会话。被默认设置、世界或会话引用的预设/模型不能直接删除。

## 世界与文件

| 方法 | 路径 | 能力 |
|---|---|---|
| GET | /worlds | 摘要列表，名称和标签筛选 |
| POST | /worlds/import | multipart file 字段上传 JSON 或 ZIP 世界卡 |
| GET / HEAD | /worlds/:id/export | 按当前世界重建 ZIP / 下载头 |
| GET / PATCH / DELETE | /worlds/:id | 领域详情 / 管理字段修改 / 删除世界及确认后的关联会话 |
| GET | /worlds/tags | 已绑定标签 `{name,worldCount}` |
| GET | /worlds/:id/components | 已解析组件源码及按组件 ID 返回的错误 |
| GET | /worlds/:id/character-sprites | 世界声明的完整立绘素材目录 |
| GET / HEAD | /worlds/:id/original | 下载或检查已保存原件 |
| GET / HEAD | /worlds/:id/resources/* | 读取或检查包内组件、素材等资源 |

世界列表支持 q（名称包含匹配，最多 200 字符）、tag（精确标签名）、limit（1–200，默认 24）、cursor；不接受 offset/tagId。按 createdAt/id 倒序进行 keyset 分页，编辑内容或状态不改变顺序。游标绑定名称及标签筛选，不能挪到其他查询。Repository 直接读取摘要列并批量读取本页标签，不解析作者 JSON；sessionCount 由 route 调 SessionService 批量组合，不跨模块 JOIN。

列表项为 `{id,name,cover,coverMosaicEnabled,tags:string[],sessionCount,createdAt,updatedAt}`。详情为 `data.item`，顶层字段包括 id、revision、specVersion、name、description、cover、coverMosaicEnabled、tags、characters、openings、lorebook、stateDefinition、messageRender、components、stageComponent、extensions、defaultPresetId、defaultReplyAssistPresetId、defaultApiModelConfigId、createdAt、updatedAt。不再包装 item.data 或返回空 warnings；stateDefinition 是作者声明，详情不包含运行 state。description 保留 null、组件对象或已有文本；作者对象内部协议键不递归转换。

PATCH 仅接受 name、tags、coverMosaicEnabled、defaultPresetId、defaultReplyAssistPresetId、defaultApiModelConfigId 的非空子集，以及必填 expectedRevision。只写提交的管理列；标签 trim、去重并保留顺序，与 revision 更新在同一事务中完成。成功 revision 加一；过期返回 WORLD_REVISION_CONFLICT/409，引用不存在或校验失败不部分保存。显式 null 清除世界默认引用；defaultReplyAssistPresetId 仅接受 reply_assist 类型预设，创建会话时预填到 runtimeConfig.replyAssistPresetId，null 继续表示跟随应用默认。默认预设和模型引用是本机配置，不随世界卡导出。不提供 POST /worlds、PUT /worlds/:id/tags 或旧 /tags 别名；除上述马赛克保留键外，作者内容与运行状态不通过管理 PATCH 更新。

`coverMosaicEnabled` 是 `extensions.cover_mosaic_enabled` 的布尔投影，缺省 false。管理写入只合并这一键到 `worlds.extensions_json`，保留其他扩展项，并复用 expectedRevision 的原子更新；不接受任意 extensions 覆盖。列表摘要仅投影该键，不逐世界读取完整内容。正式卡协议为 `data.extensions.cover_mosaic_enabled`，只接受布尔值，普通导出和再次导入保留 true/false；下载原件仍返回最初上传字节。

`/components` 返回 `data:{items:[{id,component}],errors:Record<string,string>}`。path 声明优先于 inline，文件读取失败不回退；路径、编码和大小检查由 worlds 内部复用，单个组件错误不阻塞其他组件读取，错误不暴露绝对磁盘路径。前端按需编译，接口不执行作者代码。

资源接口 `/worlds/:id/resources/*` 的通配路径相对于磁盘 `package/` 根目录，例如 `resources/assets/cover.png`、`resources/components/intro.tsx`；保留读取包内文件的范围，不限于素材目录。HTTP 路径命名不改变磁盘布局或现有路径安全规则。

原件下载固定文件名为 `original.json` 或 `original.zip`，反映已保存的原始字节。包资源路径允许子目录，拒绝路径穿越和符号链接；资源响应包含 MIME、nosniff、只读文档 CSP 和 Access-Control-Allow-Origin: *；文件打开和流生命周期在世界模块内部处理。

DELETE `/worlds/:id` 未确认关联删除时，有关联会话返回 WORLD_HAS_SESSIONS/409，errorMessage 提示会话数量及再次确认会一并删除会话和消息；此时不修改数据库或文件。再次确认发送 `?deleteSessions=true`；省略或显式 `false` 均不授权删除会话，deleteSessions 的其他取值返回 INVALID_REQUEST/400。没有关联会话时直接删除。

删除由用例编排：在同一个同步数据库事务中，通过 SessionService 删除该世界的全部关联会话及其消息，再删除世界和标签；沿用 SESSION_WRITE_LOCKED，任一会话正在运行或任一步骤失败时，整个事务回滚。配置 canAccessSession 时逐一检查关联会话的访问权限；异步检查后在事务内重新查询，发现未授权的新会话时返回 WORLD_HAS_SESSIONS，保持数据不变。数据库提交后清理整个世界根目录，包括 source/ 和 package/。目录缺失视为已清理；DB 已不存在但目录残留时，重试同一 DELETE 仍会清理并返回成功。两者均不存在返回 WORLD_NOT_FOUND。

文件清理失败返回 WORLD_FILES_DELETE_FAILED，不回滚已完成的 DB 删除；调用方可重试。文件写入/删除按世界串行，并拒绝不安全的世界根目录；不会跟随内部符号链接删除外部目标。

世界模块内部职责：`parser.ts` 解码 JSON、调用统一校验并转换卡片与领域对象；`validation.ts` 校验卡结构、引用、状态与条件表达式；`assets.ts` 读取组件源码并检查资源引用；`archive.ts` 处理导入文件、ZIP 解压和导出打包；`files.ts` 管理目录、暂存、发布、清理和文件流。条件表达式只做静态验证，不执行。上述实现通过 `service.ts` 对外提供能力，不改变本节 HTTP 和磁盘布局契约。

世界导入采用multipart/form-data，HTTP 层按实际字节限制读取正文流并保留 boundary，不依赖 Node 适配器 Request 对象具有原生 Fetch 内部状态。只接受一个file字段，扩展名为.json或.zip。上传原名只用于判断格式，不保存、不参与导出命名；保留上传原始字节。ZIP根目录为world.json，资源只能位于components/和assets/，允许子目录；验证重复/冲突路径、符号链接、大小、资源引用和世界卡内容。JSON导入不能引用不存在的包内资源。卡使用spec_version和data，不再要求固定spec标识，导出也不生成spec。

启动安装内置 ZIP 和手动上传共用世界导入流程。前者按发行清单的固定 ID 补齐，后者每次生成独立的 UUID。

导入由用例读取应用默认预设/模型引用，调用WorldService暂存、校验、发布文件并写入世界及标签；失败清理本次操作产生的数据和文件。数据库事务不包围异步文件操作；清理失败显式返回WORLD_IMPORT_CLEANUP_FAILED。

当前世界导出从DB读取世界卡与标签，结合package/当前资源重新构建ZIP，忽略原始上传字节与package中旧world.json。文件名为当前world.name.zip，非法文件名字符做安全替换，中文使用标准下载头编码；导出使用no-store。导出产物先完整生成，再打开下载流，完成/取消/HEAD后清理临时文件。

导出会重新校验当前内容能否表示为合法0.1世界卡。已有纯文本 description 无法表示为协议要求的组件描述时，明确返回INVALID_WORLD_CARD/422，不静默丢弃该字段。

## 会话、消息与线性历史

| 方法 | 路径 | 能力 |
|---|---|---|
| GET / POST | /sessions | 会话列表 / 创建 |
| GET / PATCH / DELETE | /sessions/:id | 会话读取 / 修改 / 删除 |
| POST | /sessions/:id/entries | 追加普通消息 |
| PATCH | /sessions/:id/entries/:entryId | 普通消息正文或 extData 更新 |
| GET | /sessions/:id/entries/:entryId/character-sprites | 指定消息自身的立绘结果，缺失为 null |
| POST | /sessions/:id/reply-assist | 提交 {requestId,draftText}，UUID 由宿主生成，草稿上限 100000 字符。成功返回 202 和 {sessionId,requestId,accepted:true} |
| POST | /sessions/:id/reply-assist/:requestId/stop | 取消匹配的帮答，返回 {sessionId,requestId,stopping:true}。已结束或不匹配返回 404 |
| POST | /sessions/:id/narrative/runs | 保存用户消息并受理一次叙事生成 |
| POST | /sessions/:id/narrative/runs/:runId/stop | 显式停止当前匹配的叙事生成 |
| GET | /sessions/:id/narrative/runs | 每页最多 5 轮的完整历史或 afterSeq 补查 |
| GET | /sessions/:id/narrative/usage | 已记录的模型用量汇总 |
| GET / HEAD | /sessions/:id/events | SSE 事件连接 / 仅检查响应头 |

会话列表支持 worldId、limit、cursor，不提供关键词搜索。route 解析游标位置后调用 SessionService；列表项的 worldName/cover 通过 WorldService 在 route 组合，同一请求缓存重复世界读取。SessionService 只返回自身的 Session 领域对象。已保存消息通过轮次游标分页读取。整数 query 必须是合法安全整数，再由 Service 校验允许范围。

会话列表、创建、详情与更新响应均返回会话的 `runtimeConfig`。配置存储在 `sessions.runtime_config`，三个引用由 SQLite 虚拟生成列维护外键约束。

| API 字段 | JSON 存储键 | 含义 |
|---|---|---|
| narrativePresetId | narrative_preset_id | 必填，叙事预设 |
| apiModelConfigId | api_model_config_id | 必填，叙事模型配置 |
| replyAssistPresetId | reply_assist_preset_id | 帮答预设，默认 null，表示跟随应用默认值 |
| replyAssistGoal | replay_assist_goal | 帮答目标，最多 2000 字符，默认空字符串 |
| fontSize | font_size | 故事正文字号，13–21 的整数，默认 16 |

`PATCH /sessions/:id` 接受 `title` 和部分 `runtimeConfig`。例如 `{"runtimeConfig":{"fontSize":18,"replyAssistPresetId":null}}` 只调整字号并恢复跟随应用默认，其他配置在同一事务内保留。

摘要仅由叙事流程生成：POST entries 禁止 type=compaction；PATCH entries 禁止修改 compaction 的 payload/extData，也禁止向普通消息写入 summary 元数据。成功摘要通过 narrative/runs 分页中的 entries 读取，payload.summary 为文本，extData.summary 为 {coveredThroughEntryId,sourceHash}，指标保存在该 entry.metrics；state=null 继承。savedMessageIds 不包含摘要，tipEntryId 可以指向摘要。

### 运行期间写入锁

本地单进程使用 `infrastructure/cache/RuntimeCache`，与所有 Session/World Service 和叙事用例共享。锁在保存本轮 user 前取得，覆盖上下文、摘要、主模型、后处理及结束结果保存。失败、取消和正常关闭均释放；结算完成先解锁，再发布能力通知、usage 与终态。内部持有者令牌按对象身份校验，不接受客户端提供，旧 run 的 finally 不会释放下一轮锁。

| 被拦截的写入 | HTTP | errorCode |
|---|---|---|
| 当前会话 PATCH/DELETE、entries POST/PATCH，以及服务内部的无持有者计量/结果写入 | 409 | `SESSION_WRITE_LOCKED` |
| 当前会话 session/message 状态 PUT/PATCH，包括空更新、同值和原本会忽略的缺失路径 | 409 | `STATE_WRITE_LOCKED` |
| 该世界任意会话运行期间，global 状态 PUT/PATCH | 409 | `STATE_WRITE_LOCKED` |
| 同会话再次提交 run | 409 | `RUN_ALREADY_ACTIVE` |

错误继续使用标准 `{success,errorCode,errorMessage,data}` 包络。读取、事件连接和显式 stop 可以正常使用；其他会话的独立状态及其他世界不受影响。新建不同 ID 的会话不受阻断，因为不修改已有会话或 global 快照。`GET /sessions/:id/history` 已删除，不保留别名；内部 `getHistory` 仍用于上下文构建。

### 创建可用会话

`POST /sessions` 接收 `{worldId,openingId,userCharacterId,runtimeConfig,id?,title?}`，不接受客户端 state。配置必须明确提交，不隐式替换；title 省略时使用开局名称，显式 null 保留无标题。不存在或不属于该世界的开局返回 INVALID_SESSION_OPENING/422；角色必须属于该世界且 player_selectable=true，否则返回 INVALID_SESSION_CHARACTER/422。模型和预设通过本域服务检查引用。

create-session 用例在同一个同步事务中校验选择、计算初始快照、创建会话、保存第一条 assistant 消息、写入该 run 的完成结果并推进 tip。任一步失败整体回滚，不留空会话。初始化直接调用属主 Service，不嵌套发布状态事件的用例，不调用模型、凭据服务或作者组件。

- global 使用 worlds.state 当前值，不重置，也不应用开局覆盖。
- session 按 stateDefinition.scopes.session 各字段 initial 初始化，缺省为 {}。
- message 按 message 定义 initial 初始化，再应用 opening.initial_state：仅允许已声明根、整项替换、不深度合并，校验完整根值；未覆盖根保留默认值。所有字段均初始化，load/when 不决定字段是否存在。结果保存为 [{key,value}]，无定义时为 []。
- 正文取 opening.content，一次性将所有精确的 {{user}} 替换为所选玩家角色名称；不修改世界原文，不执行组件或其他模板表达式。
- 第一条消息 parentId=null、seq=1、type=message、role=assistant，payload.message 使用字符串 content 与 timestamp，metrics=null。分配独立 runId，首条 extData.narrative 保存 completed+finishedAt，extData.output 记录初始化后的 message 根更新和空建议数组，不保存 kind、origin 或开局身份元数据。

成功返回 201，`data:{item:SessionView,entry:SessionEntry}`，item.tipEntryId 已指向返回消息。提交后仅发布一次 session.created，不发布 run.* 或 state.changed。会话创建时一般还没有 SSE 订阅，首次展示使用响应或已保存历史，不依赖事件。重复 id 返回冲突，不重复创建；不提供后台任务或自动重试。已有会话不自动补开场、重置状态。

消息保持线性父链，重新生成支持删除最新回复。parentId 可省略，默认当前 tip；显式值不匹配时返回 TIP_CONFLICT。追加只核对本会话当前 tip 与最大 seq。新条目、seq 与 tip 的原子更新归 SessionRepository；没有 setTip 或分支切换接口。

SessionEntry 使用 sessionId、parentId、runId、extData、metrics、createdAt/updatedAt，payload 与状态内容保持原键。HTTP 追加条目不接受 metrics，也不提供编辑计量的 HTTP 路由；计量由进程内 SessionService 写入。runId 仅关联同组已保存消息，不区分创建时的首条消息与模型生成；轮次列表组合 entries 与本组首条 entry 的 extData.narrative；缺少结束结果且无活跃运行时状态为 unknown。

会话范围的读取、修改、状态及 SSE 入口先确认真实会话，再执行可选访问检查；拒绝与不存在统一返回 SESSION_NOT_FOUND。异步检查结束后先检查停机，再确认会话仍存在。配置了访问检查时，会话列表只返回获准条目。

## 叙事提交、重新生成与停止

`POST /sessions/:id/narrative/runs` 正文为：

```json
{
  "input": { "text": "走进庭院，观察门口的守卫。" },
  "expectedTipEntryId": null
}
```

`expectedTipEntryId` 必填；没有历史时为 null，有历史时传最后读取的 tip。输入必须有非空白内容，保存原始文本。请求不接受模型或预设覆盖、requestId、工具列表、prepare 参数。会话存在性、权限、输入、tip 与同会话并发校验失败时，使用 HTTP 错误包络且不追加用户消息；同会话已有运行返回 RUN_ALREADY_ACTIVE/409，tip 过期返回 TIP_CONFLICT/409。

受理时先独立保存用户消息，再准备上下文和模型请求。202 的 data 为 `{runId,userEntryId,assistantEntryId,userMessage,tipEntryId,deletedMessageIds}`，tipEntryId 为受理后的真实 tip，普通发送 deletedMessageIds=[]；userMessage 为已保存的 `{id,role:'user',content,timestamp}`，与 run.created 中的用户消息一致。客户端收到响应即可展示用户消息，run.created 按消息 ID 确认或补偿。此时 userEntryId 已持久化，assistantEntryId 仅预分配；202 不代表生成成功。上下文按预设自动裁剪或执行至多一次摘要；一次摘要后仍超限通过 stop_reason=summary_capacity_exceeded 结束，保留已保存用户、摘要与摘要 metrics，摘要失败为 summary_failed。失败/中断摘要不保存记录或计量；成功摘要未知 usage 为 null。之后的配置、历史、预算、凭据或模型错误通过 `run.stopped` 的 stop_reason 返回，保留用户消息；SSE 不返回 error 对象或 errorCode/errorMessage。

助手正常完成、失败或停止时独立保存完整或部分公开快照，包含分离能力数据块后的干净 content、公开 reasoning_content 与 tool_calls；只有公开 reasoning 或工具请求时也保留，完全没有公开内容时只保留用户。SDK 最终快照采用替换语义。助手写入失败不回滚用户；运行期间外部追加由写锁拦截，持久化仍保留 tip 一致性校验。终态 savedMessageIds 与 tipEntryId 表达实际保存结果；后续模型历史以可见正文为底稿，由独立 context 为选中的保留条目追加只读模型旁注；不把 reasoning/工具请求当作提示词正文。内容与计量见 [叙事执行](server-narrative.md)。

`POST /sessions/:id/narrative/runs/:runId/stop` 正文必填 `{assistantEntryId}`，返回 `data:{runId,assistantEntryId,stopping:true}`。同时匹配当前 runId 和 assistantEntryId，旧执行的停止请求不能取消同轮新生成；不匹配或已结束返回 RUN_NOT_FOUND/404。返回值表示已请求停止，最终以 `run.stopped` 及其 stop_reason 为准；保存失败优先于普通取消。断开 POST 或 SSE 都不会代替显式 stop。

`POST /sessions/:id/narrative/runs/regenerate` 正文为 `{userEntryId,assistantEntryId,expectedTipEntryId}`。userEntryId 是最新轮次首条用户消息；assistantEntryId 是要删除的最新 AI，没有 AI 时显式传 null 表示重试；expectedTipEntryId 必须是当前非空 tip，可指向 compaction。开局、历史轮次、错配 AI 或用户后存在其他普通消息返回 INVALID_REGENERATION_TARGET/409；活跃运行、旧 tip 沿用 RUN_ALREADY_ACTIVE/TIP_CONFLICT。

受理前取得会话写锁，在一个事务内删除旧 AI、衔接直接后继、修正 tip 并清除旧结束结果。保留原用户、runId 和摘要，为新输出分配新 assistantEntryId；202 使用普通受理结构，tipEntryId 是提交删除后的实际 tip，deletedMessageIds 为已删 ID（普通发送/无 AI 重试为 []）。提交后发布 message.deleted 与实际 message 状态变化，再使用正常 run.created/增量/用量/终态。准备或生成失败不恢复旧 AI；部分输出按普通发送规则保存，无输出则可对同一用户重试。用量仍汇总现存 entries，不保留已删 AI 的计量。没有额外的通用消息删除 HTTP 入口。

客户端应先连接 `/sessions/:id/events` 再提交；事件可能早于 POST 响应，按 runId/messageId 关联。断线后重新读取 entries 或 narrative/runs 判断已保存内容，不自动重发提交。没有事件回放、重启续跑、自动重试或请求去重接口；Web 按这些约束接入会话运行，详见 [Web 运行接入](web-runtime.md)。

## 叙事查询与用量

旧 `/sessions/:id/runs`、`/sessions/:id/runs/:runId/stop`、`/sessions/:id/runs/:runId/entries` 路径不保留别名。事件仍使用 `/sessions/:id/events`，不新增 narrative/events 或 capabilities，提交响应也不返回 capabilities。

`GET /sessions/:id/narrative/runs` 支持以下互斥模式。limit 可取 1 到 5 的整数，默认 5，其他值返回 INVALID_REQUEST。

| 查询 | 行为 |
| --- | --- |
| 无 cursor/afterSeq | 按每轮首条 entry.seq 倒序返回最新 5 轮 |
| cursor | 按游标指定的首条 seq 向前倒序查询，不受之后追加的消息影响 |
| afterSeq | 按每轮最后已保存 entry.seq 升序返回 seq 大于该位置的轮次，最多 5 轮 |

返回 `data:{items,hasMore,nextCursor,nextAfterSeq,activeRunId}`。每个 item 为 `{runId,firstSeq,lastSeq,entries,status,assistantEntryId?,finishedAt?,stopReason?}`，entries 按 seq 升序，包含该轮所有已保存条目，单轮不被拆页。cursor 绑定会话；cursor 与 afterSeq 不可同时传。前向查询按最后 seq 排序，以免非连续 runId 分组导致遗漏；不是按 run 创建位置筛选。

向前翻页使用 nextCursor；增量补查使用 nextAfterSeq，hasMore=true 时继续补查。nextAfterSeq 是本页最大 lastSeq，不是事件序号；空页为 null，客户端保持原检查点。浏览历史页面的 nextAfterSeq 不应覆盖客户端已知的较大检查点。activeRunId 是查询时该会话仍活跃的轮次，不受分页范围限制。

列表项的 status 为 completed/stopped（来自已保存结果），running/stopping（来自匹配的内存运行），或 unknown（无活跃运行且没有有效结束结果）。实时生成的正文来自会话 SSE 的 run.delta。

客户端初次打开、重连或显式同步时读取最新一页并替换原分页缓存（最多 5 轮）。删除可使 lastSeq 变小，新消息可复用 seq，afterSeq 不能证明旧条目仍存在。普通终态补查可从活跃轮次末 seq 前一位置重叠读取，以观察仅更新结束结果的情况。读取代次防止删除前的旧响应回填消息；断线期间未保存的分片不回放，等待最终 snapshot 或持久历史。

每个 run 首条 entry 的 extData.narrative 仅由服务内部写入，不限定 user/assistant 角色：

```ts
type NarrativeOutcome =
  | { status: 'completed'; assistantEntryId?: string; finishedAt: number }
  | { status: 'stopped'; assistantEntryId?: string; stopReason: NarrativeStopReason; finishedAt: number };
```

finishedAt 为结算 Unix 毫秒；stopReason 与当前 SSE 的原因类型一致，例如 cancelled、provider_error、output_incomplete、message_persist_failed。创建用户时仍为 extData:{}；先保存已有助手内容，再记录用户结束结果，最后发布终态。没有助手输出也会记录结果。写入仅替换 narrative 字段，保留其他扩展；通用 POST/PATCH entry 不能传 narrative/output，通用 extData 替换会保留服务端已存 narrative/output；正文编辑不重新执行或回滚能力结果。结果写入失败不回滚已有消息，刷新后可能 unknown；不持久化 running 或执行恢复日志，不新增表。

metrics.requests 每项为 `{requestId,provider,modelId,usage,durationMs?,firstTextMs?}`，不再写 status。新请求 provider 取实际调用的 providerId；读取旧 metrics 时移除 status，缺少 provider 返回 null，不根据当前模型配置推断。旧 JSON 不做批量重写，新写入严格使用新结构。

`GET /sessions/:id/narrative/usage` 返回 `data:{knownUsage,recordedRequestCount,unknownUsageRequestCount,latestContext}`。knownUsage 包含 inputTokens/outputTokens/totalTokens/cacheReadTokens/cacheWriteTokens，是已有 metrics 中可信 usage 的合计；unknownUsageRequestCount 统计 usage:null 的已记录请求，不将其视为零。没有助手 entry 等原因导致未记录的请求不在计数中，因此这是已记录用量而非完整账单；不写 session.usage 或增加计量表。

主叙事调用在实际请求发生后将最终编译快照附加到助手 `metrics.context`：

```ts
{
  requestId: string; // 对应同一 metrics.requests 内的实际调用
  apiModelConfigId: string;
  contextWindowTokens: number;
  contextComposition: { systemBytes: number; summaryBytes: number; historyBytes: number };
}
```

`latestContext` 为 `null` 或：

```ts
{
  inputTokens: number | null;
  contextWindowTokens: number | null;
  modelId: string;
  stale: boolean;
  contextComposition?: { systemBytes: number; summaryBytes: number; historyBytes: number };
}
```

它只选最新已保存的主叙事 assistant 请求，排除 compaction；输入量取该请求真实 usage，未知时为 null，不拿上一轮已知用量替代。旧记录没有快照时窗口为 null、组成省略，不猜测历史模型窗口。切换配置、当前配置的供应商/模型改变或快照条目的 seq 超过当前 tip时 stale=true；正常追加下一轮或改标题不使旧快照自动过期。没有实际请求或没有保存助手时不产生新快照。

组成来自最终发给模型的 UTF-8 文本：系统模板/材料/后处理说明归 system，摘要归 summary，历史正文/模型旁注/本次 input.text 归 history。沿用 V1 每消息 16 B 的约定开销，普通拼装消息归 system、历史消息归 history。只统计实际发出的内容；这是字节占比，不是逐类计费 Token。上下文窗口占比使用实际 inputTokens/contextWindowTokens，累计 Token 包含已记录摘要及主叙事请求，缓存读写作为输入细分不重复相加。

## 叙事后处理结果

正常完成的正文 entry 可在 extData.output 返回：

```ts
{
  stateUpdate: {
    status: 'no_updates' | 'success' | 'partial_success' | 'invalid_updates' | 'invalid_tag' | 'processing_error',
    updates: Array<
      { status: 'success'; path: string; value: JsonValue; reason?: string }
      | {
        status: 'invalid_json' | 'invalid_update' | 'invalid_path' | 'invalid_value' | 'processing_error';
        path?: string; value?: JsonValue; reason?: string;
        errorCode?: string; statePath?: string; rulePath?: string;
      }
    >,
    errors?: Array<{ errorCode: string }>
  },
  actionSuggestions: {
    status: 'no_suggestions' | 'success' | 'partial_success' | 'invalid_tag' | 'invalid_json' | 'invalid_suggestions' | 'processing_error',
    items: string[],
    errors?: Array<{ errorCode: string }>
  },
  characterSprite?: {
    status: 'success' | 'partial_success' | 'invalid_items' | 'invalid_tag' | 'processing_error',
    items: Array<{
      position: 'left' | 'center' | 'right' | 'top' | 'topleft' | 'topright' | 'truecenter';
      characterId: string; spriteId: string;
    }>,
    errors?: Array<{ errorCode: string; line?: number }>
  }
}
```

结果随轮次列表中的 entries 返回。立绘另提供目录与精确消息结果两个只读 GET；状态/建议不新增独立查询端点，所有能力均无独立写入 API，也不增加能力开关响应字段。output 由 SessionService 的受控叙事保存入口写入，普通 POST/PATCH 不能伪造或删除。

每个能力按实际输出独立匹配大小写不敏感的自身标签，不读取预设或 enabled。状态/建议缺失或空块为 no_updates/no_suggestions，坏标签为 invalid_tag。stateUpdate.updates 保存全部成功/失败记录，建议仅保留过滤后的有效 items，三条只是 prompt 目标；这两类结果不含 results、blockIndex、line 或额外 index，errors 为能力级诊断。立绘缺标签不创建 characterSprite 字段；逐行接收只有 position/characterId/spriteId 的扁平对象，角色和位置分别唯一，第一条有效行优先，失败行不占位。支持七种位置，允许超过两项。立绘 errors.line 单独记录从 1 开始的非空数据行序号；标签/能力级诊断可不含 line。

run.completed 表示正文主流程完成，不等同于能力全部成功。能力异常记录在 output，查询方可查看能力状态与状态更新行诊断；模型取消、错误、length 等未执行后处理时，部分助手不产生 output。旧消息没有 output 不补造结果。

新写入严格校验上述结构。既有 state/action 输出读取归一化保持原规则：旧成功 results 与 updates 按顺序配对，保留重复路径与 reason，不虚构已应用更新；旧建议只移除 results。立绘字段存在但结构损坏时，投影为 processing_error、items=[]、错误码 CHARACTER_SPRITE_STORED_RESULT_INVALID；字段缺失保持缺失。读取不使用当前目录重新否定历史合法角色/素材 ID，不重写原存储，不增加数据库迁移。

公开与持久化正文保持干净。context 先选捕获历史中最近两条有可见正文的 assistant，再按当前节点与材料条件构建来源；仅最终保留消息才附旁注。状态只取成功 updates，建议只取有效 items，立绘只取该消息 success/partial_success 的有效 items，均不注入错误诊断。启用的立绘来源在无结果、失败、损坏或读取/序列化异常时附完整空标签，关闭或无素材时不附。历史空标签不将 null/失败改为成功，不回写消息或触发清场。旁注只进入主模型和实际预算，不进入 HTTP 正文、摘要或关键词。状态/建议不持久化行号；立绘 errors.line 按上述契约保存。不新增 notes 表或历史重建接口。

建议创建事件为 action_suggestions.created，仅发布本轮已保存的有效非空建议；run.created 驱动清空上一轮建议，首次恢复只认最新 run 的实际完成结果。详见 [会话事件](server-events.md#行动建议创建) 与 [叙事执行](server-narrative.md#叙事后处理与能力结果)。

## 立绘查询

两项 GET 均不读取预设，不受节点开关影响。立绘是完整消息快照；目录提供素材元数据，消息接口只读取指定消息，不提供当前画面继承或跨消息 merge。

### 素材目录

`GET /worlds/:id/character-sprites` 调用 WorldService.getCharacterSpriteCatalog，按世界卡角色及 sprites 原顺序返回全卡已声明目录，不按角色 load 筛选。没有素材返回 items=[]，世界不存在返回 WORLD_NOT_FOUND/404。

HTTP 200 成功包络：

```json
{
  "success": true,
  "errorCode": null,
  "errorMessage": "",
  "data": {
    "worldId": "w-1",
    "items": [
      {
        "characterId": "alice",
        "characterName": "爱丽丝",
        "spriteId": "default",
        "description": "平静站立。",
        "asset": "sr-asset://assets/characters/alice/default.webp"
      }
    ]
  }
}
```

每张素材一项，以 characterId + spriteId 关联；响应不包含角色完整 prompt、load 条件、图片字节或绝对磁盘路径。素材协议见 [世界卡协议](../reference/world-card.md)。

### 指定消息结果

`GET /sessions/:id/entries/:entryId/character-sprites` 先执行 requireSessionAccess，再调用 SessionService.getMessageCharacterSprites 校验 sessionId 与消息归属。返回 data:{sessionId,messageId,result}。result 始终只属于目标消息，不查最近有效画面、不向前继承。

部分通过的 HTTP 200 示例：

```json
{
  "success": true,
  "errorCode": null,
  "errorMessage": "",
  "data": {
    "sessionId": "s-1",
    "messageId": "m-1",
    "result": {
      "status": "partial_success",
      "items": [
        {
          "position": "left",
          "characterId": "alice",
          "spriteId": "smile"
        },
        {
          "position": "center",
          "characterId": "bob",
          "spriteId": "default"
        }
      ],
      "errors": [
        {
          "line": 2,
          "errorCode": "duplicate_position"
        }
      ]
    }
  }
}
```

| result | 读取与应用语义 |
| --- | --- |
| null | 用户消息，或助手没有该能力结果；不代表明确清场 |
| success + 非空 items | 完整成功快照，整体替换 |
| success + [] | 模型明确空标签产生的成功空快照，可清场 |
| partial_success | 接受行组成完整快照；保留 errors，不补回上一消息条目 |
| invalid_items + [] | 非空块全部行失败，无可应用快照 |
| invalid_tag / processing_error + [] | 标签或处理失败；无可应用快照 |

会话不存在/不可访问返回 SESSION_NOT_FOUND/404；消息不存在或不属于该会话返回 ENTRY_NOT_FOUND/404；compaction 等非 message 目标及非法参数返回 INVALID_REQUEST/400。历史旁注补出的空标签不改变 result。重新生成删除旧消息后，旧 ID 返回不存在，新回复使用新的 messageId。

可应用结果提交后，经现有 session SSE 发布 character_sprite.changed，携带 sessionId/runId/messageId/items；success 空数组也发，partial_success 发全部有效条目，失败不发。errors 不重复放入 SSE，调用方可查询对应消息。事件及顺序见 [会话事件](server-events.md)。

### 资源与 Stage 边界

目录返回的 asset 交给既有资源解析能力；包内资源继续使用 GET /worlds/:id/resources/*，沿用路径与 MIME 校验，不新建立绘下载路由。Web 会话宿主复用该目录与指定消息契约，展示规则见[会话运行接入](web-runtime.md#悬浮立绘)。

## 舞台部署配置

`GET /runtime/config` 返回 `data:{stage:{origin,entryPath:"/frame.html"},debug}`，Cache-Control 为 no-store。origin 是含端口的完整公开 HTTP(S) 来源。本地默认从启动时枚举的回环及网卡 IPv4 主站来源中精确匹配请求来源，为匹配的主站返回同一主机的 5177 端口；未知来源使用固定默认值。显式配置部署来源时使用固定配置。来源不能与 Web 同源；HTTPS Web 不允许 HTTP 舞台。debug 是前端调试开关，不返回内部环境变量或凭据。

传入 `?sessionId=:id` 后，服务端校验会话访问权限，并在同一响应的 `data` 中增加 `capabilities.characterSprite.available` 布尔值。当前会话绑定预设的角色立绘节点显式启用，且该世界至少有一项已声明的角色立绘时返回 true。该值与本轮有无立绘输出、玩家显示偏好独立。每次查询读取当前配置；会话不存在或无访问权返回 `404 SESSION_NOT_FOUND`。

默认舞台来源 `http://127.0.0.1:5177`；CLI 配置 SERVER_STAGE_ORIGIN、SERVER_DEBUG=true，以及已有 SERVER_WEB_ORIGIN。舞台由独立静态来源提供，Server 配置接口不启动额外监听器。Web 隔离构建包含 frame.html 和 world-component.html，管理来源仅有 index.html；运行 UI 与 Stage SDK 使用本节叙事和 state 契约。

## 状态接口

状态 HTTP 统一归属 state 模块。以下三个 scope 各提供 GET、PATCH、PUT，共 9 个接口；本表仍省略统一的 `/api/v1` 前缀。

| Scope | 方法 | 路径 | GET/PUT 的状态值 |
|---|---|---|---|
| global | GET / PATCH / PUT | /state/global/:worldId | 完整 JSON 对象 |
| session | GET / PATCH / PUT | /state/session/:sessionId | 完整 JSON 对象 |
| message | GET / PATCH / PUT | /state/message/:sessionId/:entryId | 完整 JSON 数组或 null |

不提供 `GET /state/views`。需要全部状态时，调用方分别请求三个 scope。原 `/worlds/:worldId/state`、`/sessions/:id/state`、`/sessions/:id/entries/:entryId/state` 的 GET/PUT 全部移除，不保留别名。

session/message 的所有方法按路径中的 sessionId 调用 `requireSessionAccess`；message 还检查 entryId 是否属于该会话。global 检查 worldId 对应世界存在。权限及所属对象错误在请求层返回，空 PATCH 批次也不能绕过这些检查。

### 读取与整快照写

GET 和 PUT 的成功 data 均为 `{ item: 状态值 }`。PUT 正文必须且只能包含 state，例如：

```json
{ "state": { "gold": 20, "weather": "rain" } }
```

PUT 完整替换所选 scope，用于初始化、重置或恢复已保存快照。global/session 接受 JSON 对象。message 接受 `[{ "key": "gold", "value": 20 }]` 形式的快照数组或 null；GET 返回沿前驱继承后的有效快照，PUT 写入指定条目自身。消息 null 恢复继承，显式空数组终止继承；没有有效继承值时 GET 成功返回 null，消息不存在返回 404。

### 字段级写

PATCH 正文必须且只能包含 updates，数组每项必须且只能包含字符串 path 和显式 value；scope 由 URL 决定，不在每项中重复提供：

```json
{
  "updates": [
    { "path": "coins", "value": 20 },
    { "path": "inventory.keys", "value": 1 }
  ]
}
```

一次请求只操作一个 scope。空 updates 返回空结果数组。请求结构错误整体拒绝；结构有效后，按输入顺序逐项处理，结果顺序与输入一致，重复路径的后项读取前项已提交的值。

每项采用独立同步事务：读取当前状态、计算候选值、校验目标根、保存变更。某项失败仅回滚该项，保留先前成功项并继续后续项。不存在跨项或跨 scope 的整体事务。

path 支持根名及对象点分路径，例如 `inventory.keys`。目标根、中间节点或末级字段不存在时，成功忽略且不创建节点；快照中的根没有对应 state 定义时也成功忽略。非法路径仍返回字段错误；不接受原型相关危险键、数组索引或 rules 中的 `[]` 模板路径。数组通过已有路径整体替换；value 是完整新值，null 是值而非删除操作。

字段实际存在时，使用共享 `state-validation` 检查受影响根的声明和更新后完整根值；不扫描同 scope 的其他根。检查包含根类型、number 根的 min/max、安全 JSON、大小和深度。可选的 rules 仅为给模型的自然语言说明，不决定字段能否更新；SDK 字段写不受根的 load 激活条件限制。

缺失路径以及新值与当前值相同的成功项都不写数据库。message PATCH 从指定条目的有效继承状态计算；实际变更时将结果保存为该条目的独立快照，不改前驱。成功忽略及未变化项保持该条目原有的 null 继承状态。

PATCH 成功接受批次时使用标准 HTTP 成功包络，`data` 为 `StateWriteResult[]`。单项均包含 path、scope、success、errorCode、errorMessage：

- 成功项：`success:true, errorCode:null, errorMessage:""`，包括实际写入、未变化和缺失路径忽略。
- 失败项：`success:false`，携带业务 errorCode/errorMessage；状态校验错误可附加 stateScope、statePath、rulePath，指向实际失败的根、字段或规则。
- 外层 success 表示批次已处理，不代表每项均成功。即使全部项失败，逐项结果仍在 data 数组中返回。

StateService 负责读取、继承、业务校验和候选快照计算。set-state 用例通过绑定的 TransactionRunner 管理每项事务，并调用表属主 World/Session Service 写入。state 不增加表或 Repository，路由不写 SQL、不管理事务。内部 getViews/evaluateWhen 保留给叙事上下文和材料条件使用；叙事后处理使用纯 prepareMessageUpdates 计算模型 JSONL 候选，仅允许本轮激活的 message 根与已存在路径，缺失路径记录该行 invalid_path；公共 PATCH 仍成功忽略缺失路径。不增加 Run/State 并发锁或时序保证。

### 事件与调用方接入边界

`state.changed` 使用既有事件契约，通过 `/api/v1/sessions/:id/events` 推送：

```ts
{ event: 'state.changed', data: { path, scope, value } }
```

仅在成功提交且有效状态实际变化后发布。PATCH 每项独立提交，提交后发布该项事件，再处理下一项；缺失路径成功忽略、同值、校验失败及回滚均不发事件。PUT 对有效快照做前后比较；GET 和初始化不发事件。

- PATCH：path 为改变的对象点分路径，value 为该路径的完整新值，数组整体替换，null 是有效值而非删除。
- PUT 与带独立 state 的消息追加：path 为 `""`，value 为该 scope 的完整有效对象快照。接收方必须替换整个 scope，不能合并；`{}` 表示清空。空 path 仅用于事件，PATCH 输入仍禁止空 path。
- global：通过 SessionService 查询该世界的全部会话 ID，逐会话发布；不受列表分页限制，不影响其他世界。
- session：只发布到所属会话的所有订阅连接。
- message：比较当前 tip 的有效继承状态，`[{key,value}]` / null 解码为对象后发布。修改历史 entry 仅在影响当前 tip 时通知；被后继独立快照覆盖的历史修改不通知。PUT null 恢复继承时发送继承后的对象，不发送 null 作为清空标记。

set-state 用例在同步事务内读取、保存、计算变更与收集接收会话，提交成功后经同一个 EventHub 发布。普通 entry 追加通过 append-entry 用例处理 tip 状态变化；追加 null 状态仅继承前驱，不发事件。叙事后处理在收尾事务内预计算状态变化，再保存助手、output 与有效快照，提交并释放执行锁后发布实际变化；无变化继续 null 继承。StateService 只负责继承和变更计算，EventHub 不查询数据库。订阅监听器异常由 EventHub 隔离，不把已提交写入判为失败。

不新增连接、SSE id、事件持久化或回放。断线期间的状态事件不补发；接入方初次装载和重连时读取最新快照。

Web 的 state feature 与 Stage SDK 已按以下规则接入；世界组件预览使用新 global 路径。

- 按需读取各 scope；message GET 的数组/null 需解码成 SDK 读取使用的对象视图，全部状态由三个 GET 的结果组合。
- 混合 scope 的 batch 按 scope 分组请求对应 PATCH，再按原输入顺序合并结果。
- 订阅现有会话 SSE 的 state.changed；识别 `path: ""` 整体替换和普通路径替换。message 事件表示当前 tip，不应用到任意历史消息的缓存。
- success:true 包含成功忽略，不能将每个成功结果都当成已写入并把提交值直接加入本地快照。transport 以重新读取的服务端状态等权威结果同步缓存，避免缺失路径在客户端出现未保存的值。

## SSE 与下载例外

- SSE 成功返回原始 `text/event-stream`，只有 event/data 帧，data 均为 JSON 对象，不套 HTTP 包络、不输出裸 [DONE]。run.created、run.summarizing、run.summarized、run.delta、run.usage 和 run.completed/run.stopped 使用完整运行身份；每个 accepted run 仅发一次总 usage，再发唯一终态。字段与连接生命周期见 [会话事件](server-events.md)。
- SSE 的 HEAD 只返回响应头，不建立订阅、心跳或事件流。
- 文件成功返回原始字节流，保留MIME、长度和attachment下载头；HEAD 返回响应头且释放已打开资源。
- SSE 握手或文件打开之前的失败仍是普通 HTTP JSON 失败包络；传输已经开始后不把流改成 JSON 包络。

## Web 来源与作者预览

普通 `/api/*` 请求带 Origin 时，只接受服务自身来源或配置的 Web 来源；默认 Web 为 `http://127.0.0.1:5176`，启动参数为 `webOrigin` / `SERVER_WEB_ORIGIN`。不带 Origin 的进程内/命令行调用仍可用；Origin 校验不代替身份认证。未授权来源和 null 来源的业务请求返回 ORIGIN_NOT_ALLOWED/403。

跨来源只放行 `/api/v1/worlds/:id/resources/*` 的 GET/HEAD，不放行世界详情、状态或写入。作者预览由独立静态来源承载，无 API 代理；宿主的只读 bridge 获取状态后仅投影请求的 global 路径。预览部署约束见 [Web 管理](web-management.md)。

## 验证

函数验证使用内存或临时 SQLite、临时文件和最小 CredentialStore 替身，不访问真实凭据。配合 `typecheck`、`lint` 检查接口和边界。state 路由通过进程内请求验证，不启动真实服务或执行浏览器链路测试，前端另有函数级控制器与桥接验证，见 Web 文档。架构lint覆盖modules属主、模块唯一出口、Reader依赖、usecases边界、context唯一公开出口及无叙事/EventHub反向依赖、跨层存储访问和SQL属主；类型检查验证Reader不可调用写方法及事务不能接受异步回调。
