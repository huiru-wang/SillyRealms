# SillyRealms Server MVP API

本服务为本机单用户 Server，默认监听 `127.0.0.1:3000`；请求前缀 `/api/v1`。实际运行与验证限制见 [进度](server-mvp-progress.md)。不要把 API Key 或聊天正文写进日志和共享文件。

## 基本流程

1. `POST /worlds/import`：`multipart/form-data` 上传字段名为 `file` 的原生 WorldCard JSON；返回世界 ID 与警告。`data.tags` 使用标签名称，自动去空白、去重并写入标签表。可参考 [MVP 世界卡](../data-formats/mvp-world-card.json)。
2. `GET /providers/models` 查看按 provider 分组的内置可选模型；`POST /api-model-configs` 以 `{name,providerId,modelId,apiKey}` 建立独立配置，返回 ID，不回显 Key。同一模型可创建多个配置。`GET /api-model-configs` 可列出已有配置。
3. `POST /api-model-configs/:id/test` 显式进行真实连接及工具探测，可能产生费用。`toolVerified` 不会跨 Server 重启保存；如果带可写状态根的 Run 报 `MODEL_TOOL_UNSUPPORTED`，需先针对所选模型测试工具能力。
4. 以 [MVP 预设示例](../data-formats/mvp-preset.json)为格式调用 `POST /presets`，将 `api_model_config_id` 设置为已创建配置 ID。也可使用 `builtin/default` 并用 `PATCH /presets/builtin%2Fdefault` 设置模型配置（视 HTTP 客户端对编码斜杠的处理而定，亦可创建自己的预设）。局部修改节点示例：`{"nodes":[{"id":"main","content":"新的纯文本指令"}]}`。
5. `POST /sessions` 提交 `{worldId,openingId,userCharacterId,presetId?}`。未选择预设也可以创建和读取会话；随后可用 `PATCH /sessions/:id` 设置 `presetId`。
6. `POST /sessions/:id/runs` 提交 `{text,requestId,expectedTipEntryId}`，其中 requestId 为 UUID、expectedTipEntryId 为当前 Session 的 tip。预检通过后，响应是 UTF-8 纯文本流，`X-Run-Id` 响应头为运行 ID。模型正文不包含工具事件；流结束后用 `GET /sessions/:id/runs/:runId` 判断 completed/failed 等终态。
7. 生成中可通过另一个请求 `POST /sessions/:id/runs/:runId/stop` 停止并等待结算；摘要等预检尚未返回 Run ID 时，可使用 `POST /sessions/:id/stop` 停止当前会话的准备任务。`GET /sessions/:id/history` 按 Run 分页返回可见历史，`GET /sessions/:id/state` 返回已提交状态；刷新后可读取停止前的部分文本。

## 其他接口与约定

- 世界：`GET /worlds`、`GET /worlds/:id`、`GET /worlds/:id/export`、`DELETE /worlds/:id`。导入世界是创建世界的唯一入口。
- 标签：`GET/POST /tags`、`PATCH/DELETE /tags/:id`、`PUT /tags/order`。重命名和删除会同步修改世界卡标签名称。
- 模型配置：`GET /api-model-configs/:id`、`PATCH/DELETE /api-model-configs/:id`。删除配置不会替换引用它的预设。
- 预设：`GET /presets`、`GET /presets/:id`、`POST /presets/import`、`GET /presets/:id/export`、`PATCH/DELETE /presets/:id`。删除不检查内置标记或会话引用；旧 Session 保留，后续运行提示缺少预设。
- 会话：`GET /sessions`、`GET/PATCH/DELETE /sessions/:id`。世界和会话删除会先停止对应运行，再由应用显式删除相关记录；数据库不使用外键。
- 列表支持 `limit` 和 `cursor`；历史页 `limit` 计 Run 而不是消息。响应失败使用 `{error:{code,message,details?}}`，不返回 Key、Prompt 或聊天正文。

不提供 createWorld、updateWorld、世界线操作、重新生成、续写、UI Runtime、事件订阅、SSE 或 WebSocket。Provider 真实兼容性与能力限制以运行时测试为准。
