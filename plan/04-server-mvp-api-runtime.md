# 04 · HTTP、流式生成、停止与恢复

前置：01—03。接口前缀 `/api/v1`；非流式错误统一 `{error:{code,message,details?}}`，details 只包含安全定位信息，不能包含 API Key、Prompt 或聊天正文。本期没有 EventHub、事件 envelope、SSE、WebSocket、UI Runtime 或订阅接口。

## 1. 领域 HTTP 接口

| 方法与路径 | 行为 |
| --- | --- |
| `GET /worlds`、`GET /worlds/:id` | 世界列表、详情；列表可按名称或 tag 名称查询。 |
| `POST /worlds/import` | multipart/form-data 的 `file` 为 JSON 文件，读取 `data.tags` 名称、去重入库并新建 World；返回 `{item,warnings}`。不提供 `POST /worlds` 或 updateWorld。 |
| `GET /worlds/:id/export`、`DELETE /worlds/:id` | 导出 JSON；删除世界及其会话/Entry，关联清理由应用事务显式执行。 |
| `GET /tags?type=world`、`POST /tags` | 按类型列出或创建；同类型名称唯一。 |
| `PATCH /tags/:id`、`DELETE /tags/:id`、`PUT /tags/order` | 改名、删除或按类型全量顺序排列；改名/删除同步修正 World 中的标签名称。 |
| `GET /providers/models` | 列出 Pi 支持的可选目录，格式 `{providers:[{providerId,models:[{id,name,contextWindow,maxTokens,toolSupport}]}]}`；未知工具能力标 unknown，不假装已验证。 |
| `GET /api-model-configs`、`GET /api-model-configs/:id` | 独立的已创建模型配置列表/详情；包含 provider、model、是否配置凭据，不返回 Key。 |
| `POST /api-model-configs` | body `{name,providerId,modelId,apiKey}`，保存为一个独立配置；可针对相同模型保存多个。 |
| `PATCH /api-model-configs/:id` | 按提供的字段局部修改 name/providerId/modelId/apiKey；Key 缺省时保留，显式替换走安全存储，不回显。 |
| `DELETE /api-model-configs/:id` | 删除记录及对应 Key；不检查引用，已有 Preset 保留悬空 ID，运行时报错；失败需报告凭据清理结果。 |
| `POST /api-model-configs/:id/test` | 用户显式发起最小真实连接测试，可能消耗费用。 |
| `GET /presets`、`GET /presets/:id`、`POST /presets` | 列出、详情、完整新建；模型通过 `api_model_config_id` 选择已有配置。 |
| `POST /presets/import`、`GET /presets/:id/export` | 导入/导出 JSON；不携带 Key。导出不检查内置标记或被引用情况，导入跨环境缺失模型配置时返回提示。 |
| `PATCH /presets/:id` | updatePreset，按 02 的字段及节点 ID 局部更新，整体校验后原子保存。 |
| `DELETE /presets/:id` | 不检查内置标记、不检查引用，直接删除；引用它的 Session 保留、后续运行报 `PRESET_NOT_FOUND`。 |
| `GET /sessions`、`GET /sessions/:id`、`POST /sessions` | 列表、详情、从 world/opening/角色创建，初始化状态与 Opening。`POST` body 为 `{worldId,openingId,userCharacterId,presetId?,title?}`；presetId 缺省或 null 允许，不检查其存在性、模型配置或凭据；非空 ID 原样保存。 |
| `PATCH /sessions/:id`、`DELETE /sessions/:id` | 更新标题、有效玩家角色或 presetId；可清空或保存暂不可用的预设引用，不检查预设可用性；删除显式清除 Entry。 |
| `GET /sessions/:id/history?cursor=&limit=10` | 当前 tip 祖先链按 Run 分页，返回叙事、Run 状态、hasMore 和 nextCursor；包含停止时的部分文本。 |
| `GET /sessions/:id/state` | 读取 `{global,session,message,tipEntryId}` 已持久化状态。 |
| `POST /sessions/:id/runs` | body `{text,requestId,expectedTipEntryId}`；预检通过并提交本轮 User 后，以 `Content-Type: text/plain; charset=utf-8` 流式返回 Assistant 纯文本，响应头 `X-Run-Id` 标记 Run。 |
| `POST /sessions/:id/stop` | 停止当前会话任务；摘要预检尚未返回 runId 时也可使用。 |
| `POST /sessions/:id/runs/:runId/stop` | 请求取消并等待输出与状态结算；成功返回 `{runId,status:'stopped',tipEntryId}`。同一 Run 重复 stop 返回已确定状态。 |
| `GET /sessions/:id/runs/:runId` | 返回运行状态 `running/completed/stopped/failed/interrupted`、tip 及脱敏错误码，用于客户端获取最终结果。 |

`getWorldlines/switchWorldline/forkFromUserMessage/regenerateLastAssistant/continueLastAssistant` 不提供。删除 Preset 或模型配置不检查内置和引用；删除不存在 ID 返回 404，不能把其它对象错误当作成功。参数错误 400、对象不存在 404、会话正忙/预期 tip 不匹配 409、模型配置/状态不合法 422、上游故障 502/504。World 删除及 Session 删除需协调在途 Run；Preset、模型配置删除不影响已经固定在内存中的当前运行，后续运行返回引用缺失。

## 2. 纯文本流与停止

一次发送先申请会话锁并执行预检/摘要；预检时重新读取当时的预设和模型配置；presetId 未选、预设已删除、模型配置/凭据缺失或模型不可用时，分别返回明确 JSON 错误，且不写本轮 Summary/User、不调用模型。预检失败尚未发送响应头，直接返回 JSON 错误。完成后事务写 Summary（若有）和 User，再发送 200 文本流及 `X-Run-Id`；文本块只包含模型叙事 UTF-8，不发送 Tool 参数、thinking、状态内容或结构化事件。流启动后的 Provider 错误不能变更 HTTP 状态码：关闭文本流并将 Run 标为 failed，客户端用 `GET run` 查询终态。服务端流结束不能被误当成一定成功；前端集成时必须查询终态。

每个文本块进入同一会话串行队列：完整 Unicode 字符组装 → 事务写入当前 partial Assistant Entry → 数据库提交成功 → 向 HTTP 流写入这段相同文本。若客户端断开，立即停止继续向其输出；是否继续后台生成不作为本期承诺，本期触发 stop 流程并结算已成功 Tool。缓冲和背压应有上限；停止成功后等待本次写入与持久化完成，才能返回 stop 结果。历史返回与服务端已落库内容相同；正常网络中已接收到的每个片段必然存在。网络中断时写出成功不等于客户端已收到，历史可能多出末尾片段；无法提供客户端接收字节精确确认，不能承诺两边绝对相等。

支持多段 Assistant 文本及交错 Tool：每段独立 partial Entry，Tool 原始消息/结果按时间顺序插入。最终若 SDK 返回完整原始 Assistant，在已保存的相应 partial 上原位替换为含相同可见文本的真实 message，保留顺序和状态元数据；若 SDK 数据与已输出文本不一致，保留已输出 partial 作为唯一可见叙事，将原始消息单独标记为非投影诊断 Entry，绝不覆盖已发送内容或重复显示。SDK 没有完整消息或被取消时保留 `origin=stream_partial` 标记；不虚构完整原始 SDK 对象。投影器明确识别这些元数据并以已保存文本为权威。

stop 设置取消标记，阻止后续新片段与新 Tool 生效；等待已提交块完成及当前 Tool 的明确完成/取消结果，AbortController 中止 SDK；阻断迟到输出，结算先前成功的 Tool 工作状态，事务保存最终状态和 stopped 标记。若 stop 与正常完成竞争，只允许一个终态获胜，另一个返回已确定结果；状态持久化失败时 stop 返回失败、Run 标明未结算，但历史文本仍可读取。不能只保存完整 Assistant 而丢掉半条输出。

## 3. 幂等、状态和崩溃

`requestId` 在 Session 范围内去重；User Entry.ext_data 记录 requestId、请求摘要、runId 和 status。相同 ID 同输入不可启动两次；运行中的重复请求返回 409 及 runId，已结束的重复请求返回 409 与原 runId，客户端通过 history/GET run 获取结果，不重新流式执行。没有独立 Run 表；追加、状态更新与最终 tip 事务化。预检/摘要尚未写 User 前崩溃可能已发生远程调用与费用，无法提供跨崩溃严格幂等。

进程启动发现 `running` 记录时标为 `interrupted`，历史仍可读取已落库 partial；内存中尚未结算的 Tool 修改会丢失，状态返回上一次已提交快照并标记运行中断。不自动重新调用模型或生成新分支。连接断开、取消、成功、错误和重启都应在临时库做实际测试。

服务默认仅监听本机、约束 Origin 和请求体大小；日志不输出密钥或聊天正文。单 Session 同时一个在途 Run，同一数据目录仅允许一个 Server 进程，避免进程内锁被绕过。服务端目录按 `routes/、domain/、agent/、infrastructure/` 分层；不建立 events 或 UI Runtime 模块。
