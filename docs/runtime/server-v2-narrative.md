# Server V2 叙事执行

## 能力与目录边界

ServerV2 在现有会话上提供单次模型调用的叙事提交、正文增量和显式停止。用户消息受理时先保存；助手正常完成、失败或停止时分别保存已经收到的正文。两条消息不使用整体事务。

StudioV2 仍只接入管理与作者预览，未挂载叙事运行 UI。原 Server/Studio 保持独立。当前不迁移摘要、自动裁剪、模型输出扩展、状态更新、行动建议或开局初始化，不提供 Agent/tool loop、重试、重启恢复、执行状态表或事件回放。

| 位置 | 职责 |
| --- | --- |
| `src/usecases/narrative/index.ts` | 提交校验、同会话内存占位、同步保存用户和捕获快照、停止与关闭 |
| `src/usecases/narrative/execute.ts` | 消费一条模型流、聚合正文、保存助手和生成终态 |
| `src/usecases/narrative/context.ts` | 通过公开 Service 捕获会话、世界、预设、模型配置、历史和状态视图 |
| `src/usecases/narrative/materials.ts`、`compile.ts` | 材料激活、模板替换、消息编译和本地输入预算检查 |
| `src/infrastructure/pi/` | 固定版本 pi 的模型目录、解析、流接口、错误和用量转换 |
| `src/infrastructure/database/` | 数据库连接、结构及同步事务工具 |
| `src/infrastructure/events/` | EventHub 和 SSE 传输，不判断业务终态 |
| `src/modules/sessions/` | entries、线性历史和指标的属主持久化 |
| `src/modules/state/` | 状态快照、前驱继承及受限 when 只读求值 |
| `src/usecases/test-model.ts` | 已保存模型配置的一次短文本连通性检测 |

业务模块只通过 `service.ts` 提供能力；叙事用例不读取 Repository、存储行或 SQL，不接收数据库连接或 TransactionRunner。pi 不依赖业务模块、会话、entry、EventHub 或 HTTP。装配方为叙事与 SSE 注入同一个 EventHub，不逐层传递正文或终态回调。

## 提交与结束

1. HTTP 检查来源、真实会话和可选访问权限。用例检查输入非空白、expectedTipEntryId、同会话并发和停机状态；拒绝的请求不追加消息。
2. 首次 await 前占用当前会话，生成 runId、userEntryId、assistantEntryId。用户消息立即追加到请求指定的前驱；写入失败则不受理、不调用模型。
3. 用户保存后同步捕获本轮领域快照。历史中排除且只排除本轮新用户消息，message 状态从原 tip 读取。上下文准备失败作为本轮执行错误处理，已经保存的用户消息保留。
4. 返回 202 及受理标识，发布 run.started；其后解析模型、编译消息、检查顺序、读取凭据并调用 pi 一次。
5. 聚合 text_delta 并直接向 EventHub 发布 message.delta；thinking 不进入正文。无增量而最终事件包含正文时，补发正文。
6. 模型正常结束、错误、输出不完整或主动停止都进入结束保存步骤。有非空白正文时独立追加助手，parentId 必须仍为本轮 userEntryId。
7. 保存完成后释放当前会话占位，再发布唯一终态。正常完整结果为 run.completed，主动取消为 run.stopped；生成或保存失败为 run.failed。

同会话同时只允许一轮，冲突返回 RUN_ALREADY_ACTIVE，不排队；不同会话独立执行。内存 Map 只持有取消和完成信息，不承担可恢复任务存储。

run.completed 要求正常 done、stopReason=stop、无 toolCall、正文非空且与已推送增量一致，并且助手写入成功。缺少正常终态、长度截断、工具输出或正文不一致均失败；已接收到的可见正文仍按规则保存。已发送的正文不会因最终文本不一致被静默替换。

请求通过输入、权限、会话、tip 校验并完成用户保存后，上下文、模型配置、凭据或供应商失败均不删除用户。外部追加使 tip 改变时，助手写入返回 TIP_CONFLICT，不覆盖新消息；会话被删除后也不会重新创建它。

## 消息与计量

不增加表，不改变 schema version，不向 extData 填充隐藏的执行日志。单条 appendEntry 内部仍原子维护 entry、seq 和 tip；初始化等其他用例的既有事务不受影响。

```ts
user.payload = {
  message: { role: 'user', content: inputText, timestamp },
};
assistant.payload = {
  message: { role: 'assistant', content: receivedText, timestamp },
};
user.metrics = null;
assistant.metrics = {
  requests: [{
    requestId,
    modelId,
    status: 'completed', // 或 failed / cancelled
    usage,
    durationMs,
    firstTextMs, // 尚未收到正文时不提供
  }],
};
```

entry.role 与 payload.message.role 一致。同轮已有消息共享 runId；requestId 是一次模型请求的标识，不是请求去重键或事件 ID。state 为 null，保留现有前驱继承；extData 为 {}。不保存 thinking、供应商原始响应、API key 或 SDK AssistantMessage 整体。

| 结束情况 | 保存结果 |
| --- | --- |
| 完整生成并保存成功 | 用户 + 完整助手正文，助手 metrics.status=completed |
| 模型失败或输出截断，已有正文 | 用户 + 已接收助手正文，助手 metrics.status=failed |
| 主动停止，已有正文 | 用户 + 已接收助手正文，助手 metrics.status=cancelled |
| 配置、凭据、预算等失败，或模型未产生正文 | 仅用户；不生成空助手或额外计费记录 |
| 助手写入失败或 tip 冲突 | 保留用户，终态 assistantEntryId=null，不宣称正文已保存 |
| 仅收到空白字符 | 不创建助手消息 |

失败或停止的部分正文是正式可读历史，下一轮会读取它。计量随助手保存，完全无正文的失败没有助手指标载体；这些消息指标不是完整账单。session.usage 不累加。

usage 为 `{inputTokens,outputTokens,totalTokens,cacheReadTokens,cacheWriteTokens}` 或 null。输入总量包含缓存：inputTokens=input+cacheRead+cacheWrite；cache 字段是输入细分。thinking 已包含在 SDK output 时不再次相加。缺少可靠上报、字段无效或 total 口径不一致时为 null，不将 SDK 初始零值当作真实零消耗。

## 上下文与首版能力

所有配置来自当前会话的 worldId、userCharacterId、presetId 和 apiModelConfigId，不因应用默认项更新而切换。快照在凭据或模型异步等待前完成，本轮不受后续配置或消息内容编辑影响。

只接受合法的 user/assistant 消息，payload.message 的角色须与 entry.role 一致，content 为文本、timestamp 为有效非负数。已有 compaction 条目明确返回 NARRATIVE_HISTORY_UNSUPPORTED，不忽略摘要边界后继续生成。原 tip 为 null 或没有继承消息快照时，message 视图为空；不执行 opening 初始化。

角色与世界书保留 load.mode、keywords、keyword_logic、exclude_keywords、when 及 order 语义。角色通过 load.mode=never 禁用；世界书条目还支持 enabled=false。角色卡协议没有角色 enabled 字段，导入不会保留该字段。匹配区分大小写，扫描历史叙事与当前输入；用户系统指令块不用于触发关键词。when 通过 StateService 对已捕获的 global/session/message 视图进行受限 AST 求值，不执行任意 JavaScript，也不写状态。

预设节点按原顺序编译。history.messages 展开为原角色消息，自定义文本节点保留位置和角色；input.text 只在 userInput 节点插入一次。模板只识别固定变量与转义，不执行对象路径，不再次扫描已替换数据。

有效能力固定为：

```json
{ "historyPolicy": "full", "postprocess": false }
```

完整历史参与编译；history.summary 为空。即使预设保存了 rolling_summary 或 sliding_window，也不会运行摘要或裁剪。所有 kind=postprocess 节点被排除，包含默认 worldState 和 actionSuggestions；不发送扩展输出指令，也不解析或执行模型扩展块。自定义模板仍可读取 state.entries 中的现有状态和声明，缺少值时明确标为未设置，不用 initial 补值。

### 预算和生成参数

读取预设 maxContextTokens、maxOutputTokens、temperature、thinkingEnabled。请求中的 maxOutputTokens 必须为正且不超过模型目录 maxTokens；本地输入预算为：

```text
min(preset.maxContextTokens, model.contextWindow - preset.maxOutputTokens)
```

输入预算非正返回 INVALID_MODEL_BUDGET；固定本地粗估超限返回 CONTEXT_BUDGET_EXCEEDED。粗估与实际计费用量分开，不建立 usage 校准或请求指纹。供应商拒绝实际窗口超限时返回对应失败，不重试、不删历史。

maxOutputTokens 交给 pi 既有预算映射，供应商实际输出参数可能因 thinking/context 调整；这不是对供应商总输出参数的精确保证，也不会据此压缩输入历史。thinkingEnabled 开启且目录模型支持 reasoning 时请求 medium；关闭时沿用 pi 的默认映射，能否完全关闭取决于 SDK 对该模型的能力描述。

## 模型与连通性

pi 固定使用 `@earendil-works/pi-ai@1.5.0`。模型按 providerId/modelId 精确解析，未知模型失败；显式传入凭据与 AbortSignal，maxRetries=0，不传 tools。

编译结果含中途 system 消息时，仅在适配明确支持保持其位置时调用。不会把中途 system 全部前移以适配模型。兼容性取 pi openai-completions 的 supportsMidConvoSystemMessages，并仅保留已验证 DeepSeek V4.1 Flash 官方端点的窄特例。

目录的 narrativeCompatible 标记表示能处理包含中途 system 节点的叙事编排；标记为 false 的模型仍可能支持没有这种节点的具体请求。检测接口只发短文本，因此检测成功不等于任意预设顺序都可执行。

连通性检测使用已保存配置，单次请求的 maxTokens 传入 min(64, model.maxTokens)，整体等待上限 30 秒。仅返回 connected、providerId、modelId、durationMs 和标准 usage；不创建 entry/run、不回显模型回复或供应商错误文本，也不更新模型配置。具体路径见 [HTTP 契约](server-v2-http.md)。

## 停止、连接与关闭

POST 或 SSE 断开不取消叙事；只有显式 stop 或服务正常关闭触发本地取消。停止不等待供应商一定遵守 AbortSignal：本地消费者及时结束，忽略迟到结果，保存已收到正文并发布终态。

服务正常关闭先停止受理，取消当前运行，等待本地结束保存和终态发布，然后关闭 SSE、HTTP 与数据库。强制结束进程时，已保存用户仍在；尚未进入结束保存步骤的内存正文可能丢失。不逐分片刷盘，不保留重启恢复记录。

实时事件只有 event/data，没有事件 id、确认或回放。断线或重启后以 entries/history 中已保存内容为准，不能从 202 或预分配助手 ID 推断生成完成。终态及字段定义见 [会话事件](server-v2-events.md)。
