# Server V2 叙事执行

## 能力与目录边界

ServerV2 在现有会话上提供单次模型调用、正文/公开 reasoning/工具请求增量和显式停止。用户受理时先保存；助手完整或部分公开内容在正常结束、失败或停止时独立结算。两条消息不使用整体事务。SSE 只使用 ServerV2 自有契约，外部仅发布一次 run 总 usage，异常终态仅使用 stop_reason。

StudioV2 仍只接入管理与作者预览，未挂载叙事运行 UI。原 Server/Studio 保持独立。当前不迁移摘要、自动裁剪、模型输出扩展、叙事自动状态更新、行动建议或开局初始化，不提供 Agent/tool loop、重试、重启恢复、执行状态表或事件回放。

状态 HTTP 独立提供三个 scope 的 GET/PATCH/PUT，字段写入不接入本轮叙事的模型输出或结算流程。state.changed 保持 `{path,scope,value}` 契约，由状态写入及改变有效状态的普通 entry 追加在提交后发布；message 事件表示当前 tip 的有效继承视图。叙事当前仅追加 null 状态，不改变继承视图、不自动发布状态更新；内部 getViews/evaluateWhen 继续服务于叙事上下文。具体写入与读取语义见 [状态接口](server-v2-http.md#状态接口)。本轮状态接口整理仅修改服务端，StudioV2 与 SDK transport 尚未适配新路径。

| 位置 | 职责 |
| --- | --- |
| `src/usecases/narrative/index.ts` | 提交校验、同会话内存占位、同步保存用户和捕获快照、停止与关闭 |
| `src/usecases/narrative/execute.ts` | 消费一条自有模型流、聚合/替换公开快照、保存助手并形成 usage 与终态 |
| `src/usecases/narrative/context.ts` | 通过公开 Service 捕获会话、世界、预设、模型配置、历史和状态视图 |
| `src/usecases/narrative/materials.ts`、`compile.ts` | 材料激活、模板替换、消息编译和本地输入预算检查 |
| `src/infrastructure/model/client.ts` | SDK 无关的模型目录、输入消息、增量/快照、结束原因、用量及 ModelClient 接口 |
| `src/infrastructure/pi/` | 固定版本 pi 的 ModelClient 实现，内部解析 SDK 模型并转换公开消息 |
| `src/infrastructure/database/` | 数据库连接、结构及同步事务工具 |
| `src/infrastructure/events/` | EventHub 和 SSE 传输，不判断业务终态 |
| `src/modules/sessions/` | entries、线性历史和指标的属主持久化 |
| `src/modules/state/` | 状态快照、前驱继承、字段更新的目标根校验与候选快照计算，以及受限 when 只读求值 |
| `src/usecases/set-state.ts` | 通过属主 Service 保存完整快照或逐字段更新；字段写各自使用独立同步事务 |
| `src/usecases/test-model.ts` | 已保存模型配置的一次短文本连通性检测 |

业务模块只通过 `service.ts` 提供能力；叙事用例不读取 Repository、存储行或 SQL，不接收数据库连接或 TransactionRunner。用例、路由和编译器依赖自有 ModelClient/ModelInfo/ModelMessage，不接触 SDK Model、StopReason 或具体 PiClient；只在装配入口选择 PiClient 实现。pi 不依赖业务模块、会话、entry、EventHub 或 HTTP。装配方为叙事与 SSE 注入同一个 EventHub，不逐层传递正文或终态回调。

## 提交与结束

1. HTTP 检查来源、真实会话和可选访问权限。用例检查输入非空白、expectedTipEntryId、同会话并发和停机状态；拒绝的请求不追加消息。
2. 首次 await 前占用当前会话，生成 runId、userEntryId、assistantEntryId。用户消息立即追加到请求指定的前驱；写入失败则不受理、不调用模型。
3. 用户保存后同步捕获本轮领域快照。历史中排除且只排除本轮新用户消息，message 状态从原 tip 读取。上下文准备失败作为本轮执行错误处理，已经保存的用户消息保留。
4. 返回 202 及受理标识，发布带已保存 user 消息的 run.created；其后解析模型、编译消息、检查顺序、读取凭据并调用 ModelClient 一次。尚未取得模型配置时 provider/model 为 null。
5. 模型 delta 映射为 run.delta，正文、reasoning 和工具参数分别累积；final snapshot 权威替换公开内容，不要求与之前 delta 拼接完全一致。没有增量时也可以用快照输出最终消息。
6. 模型结束、错误、输出不完整或停止都进入保存步骤。有非空白正文、公开 reasoning 或工具请求时独立追加助手，parentId 必须仍为本轮 userEntryId。完全没有公开内容时不造空助手。
7. 保存助手后将结束结果写入用户 entry 的 extData.narrative，再释放当前会话占位，发布唯一一次 run.usage，再发布唯一 run.completed 或 run.stopped。stop_reason 区分取消、关闭和失败，保存失败优先；不对外发布 error 对象或 run.failed。

同会话同时只允许一轮，冲突返回 RUN_ALREADY_ACTIVE，不排队；不同会话独立执行。内存 Map 只持有取消和完成信息，不承担可恢复任务存储。

run.completed 要求模型正常 done、finishReason=stop、无工具请求、正文非空且助手写入成功。length/deferred 或缺少终态按 output_incomplete 结束；工具请求按 tool_execution_unsupported 结束；只有 reasoning 的正常结果仍保留但不视为完整正文回答。SDK 最终结果可以修正增量，明确的 snapshot 使用替换语义。模型消息 finish 与 run 持久化成功分开：生成正常而保存失败，最终仍为 run.stopped。

请求通过输入、权限、会话、tip 校验并完成用户保存后，上下文、模型配置、凭据或供应商失败均不删除用户。外部追加使 tip 改变时，助手写入返回 TIP_CONFLICT，不覆盖新消息；会话被删除后也不会重新创建它。

## 消息与计量

不增加表，不改变 schema version。extData.narrative 只保存明确的结束结果，不存执行日志或恢复记录。单条 appendEntry 内部仍原子维护 entry、seq 和 tip；初始化等其他用例的既有事务不受影响。

```ts
user.payload = {
  message: { role: 'user', content: inputText, timestamp },
};
assistant.payload = {
  message: {
    role: 'assistant', content: finalSnapshot.content,
    reasoning_content: finalSnapshot.reasoning_content,
    tool_calls: finalSnapshot.tool_calls, timestamp,
  },
};
user.metrics = null;
assistant.metrics = {
  requests: [{
    requestId,
    modelId,
    provider, // 本次调用的 providerId；旧记录缺失时为 null
    usage,
    durationMs,
    firstTextMs, // 尚未收到正文时不提供
  }],
};
```

entry.role 与 payload.message.role 一致。同轮已有消息共享 runId；requestId 是一次模型请求的标识，不是请求去重键或事件 ID。state 为 null，保留现有前驱继承；助手 extData 为 {}，用户 extData 在结束结算后包含 narrative。公开 reasoning 和工具请求与正文同属消息内容；不保存 SDK signature、redacted 数据、供应商原始响应、API key 或 SDK AssistantMessage 整体。工具参数保留字符串，包括中断时的不完整 JSON，不解析或执行。

| 结束情况 | 保存结果 |
| --- | --- |
| 完整生成并保存成功 | 用户 + 完整助手快照，用户 narrative.status=completed |
| 模型失败或输出截断，已有公开内容 | 用户 + 助手公开快照，用户 narrative.status=stopped，stopReason 为失败原因 |
| 主动停止或正常关机，已有公开内容 | 用户 + 助手公开快照，用户 narrative.status=stopped，stopReason 为 cancelled/server_shutdown |
| 只有 reasoning 或工具请求 | 保存公开快照；无正常正文或不支持的工具执行以相应 stop_reason 结束 |
| 配置、凭据、预算等失败，或没有公开内容 | 仅用户；不生成空助手 |
| 助手写入失败或 tip 冲突 | 保留用户，savedMessageIds 不包含预分配助手 ID，不宣称已保存 |
| 只有空白正文和 reasoning、没有工具请求 | 不创建助手消息 |

失败或停止的部分消息是正式可读记录，下一轮只读取其可见正文。只有 reasoning/tool_calls 而没有正文的助手记录不生成伪空模型历史，记录及真实前驱/tip 仍保留，状态从真实 pre-submit tip 读取。计量随助手保存，完全没有可保存助手时没有历史指标载体；实时 run.usage 仍按规则发布，这些指标不是完整账单。session.usage 不累加。

内部 usage 为 `{inputTokens,outputTokens,totalTokens,cacheReadTokens,cacheWriteTokens}` 或 null，SSE run.usage 映射为 snake_case。输入总量包含缓存：inputTokens=input+cacheRead+cacheWrite；cache 字段是输入细分，reasoning 已计入输出时不再次相加。没有 SDK 调用尝试时总量为真实零；尝试后无可信上报、字段无效或总量口径不一致时为 null，不把 SDK 初始零值当作已上报零。每个 accepted run 只发布一次结算总量，不带 messageId/requestId，也不在停止后等待或补发迟到统计。

## 上下文与首版能力

所有配置来自当前会话的 worldId、userCharacterId、presetId 和 apiModelConfigId，不因应用默认项更新而切换。快照在凭据或模型异步等待前完成，本轮不受后续配置或消息内容编辑影响。

只接受合法的 user/assistant 历史消息，payload.message 的角色须与 entry.role 一致，content 为文本、timestamp 为有效非负数。兼容原来的纯正文 payload；reasoning/tool_calls 不进入正文投影、材料关键词扫描或模型提示词。已有 compaction 条目明确返回 NARRATIVE_HISTORY_UNSUPPORTED，不忽略摘要边界后继续生成。原 tip 为 null 或没有继承消息快照时，message 视图为空；不执行 opening 初始化。

角色与世界书保留 load.mode、keywords、keyword_logic、exclude_keywords、when 及 order 语义。角色通过 load.mode=never 禁用；世界书条目还支持 enabled=false。角色卡协议没有角色 enabled 字段，导入不会保留该字段。匹配区分大小写，扫描历史叙事与当前输入；用户系统指令块不用于触发关键词。when 通过 StateService 对已捕获的 global/session/message 视图进行受限 AST 求值，不执行任意 JavaScript，也不写状态。

预设节点按原顺序编译。history.messages 展开为原角色消息，自定义文本节点保留位置和角色；input.text 只在 userInput 节点插入一次。模板只识别固定变量与转义，不执行对象路径，不再次扫描已替换数据。

当前仅使用完整历史，不执行后处理。这是已实现行为，不提供 capabilities HTTP 或提交响应字段。

完整历史参与编译；history.summary 为空。即使预设保存了 rolling_summary 或 sliding_window，也不会运行摘要或裁剪。所有 kind=postprocess 节点被排除，包含默认 worldState 和 actionSuggestions；不发送扩展输出指令，也不解析或执行模型扩展块。自定义模板仍可读取 state.entries 中的现有状态和声明，缺少值时明确标为未设置，不用 initial 补值。

### 预算和生成参数

读取预设 maxContextTokens、maxOutputTokens、temperature、thinkingEnabled。请求中的 maxOutputTokens 必须为正且不超过模型目录 maxTokens；本地输入预算为：

```text
min(preset.maxContextTokens, model.contextWindow - preset.maxOutputTokens)
```

输入预算非正返回 INVALID_MODEL_BUDGET；固定本地粗估超限返回 CONTEXT_BUDGET_EXCEEDED。粗估与实际计费用量分开，不建立 usage 校准或请求指纹。供应商拒绝实际窗口超限时返回对应失败，不重试、不删历史。

maxOutputTokens 交给 pi 既有预算映射，供应商实际输出参数可能因 thinking/context 调整；这不是对供应商总输出参数的精确保证，也不会据此压缩输入历史。thinkingEnabled 开启且目录模型支持 reasoning 时请求 medium；关闭时沿用 pi 的默认映射，能否完全关闭取决于 SDK 对该模型的能力描述。

## 模型与连通性

PiClient 实现项目自有 ModelClient，固定使用 `@earendil-works/pi-ai@1.5.0`。SDK 导入限制在 infrastructure/pi 内，原始 Model 不离开适配器；resolve 对外返回自有安全 ModelInfo，调用时在适配器内按 providerId/modelId 精确解析。未知模型失败；显式传入凭据与 AbortSignal，maxRetries=0，不传 tools。

适配器将 SDK text/thinking/toolcall 事件转换为自有 delta。contentIndex 映射为消息内工具序号；工具 ID/名称允许晚到，最终参数由 SDK 权威结果转换为字符串，不能把 partial 参数对象反复 stringify 后追加。done/error 返回独立公开快照；SDK partial 是可变对象，不直接跨边界暴露。公开 reasoning 不包含内部签名或 redacted 数据；工具执行循环与 SDK 私有回放数据的持久化不在本期。

编译结果含中途 system 消息时，仅在适配明确支持保持其位置时调用。不会把中途 system 全部前移以适配模型。兼容性取 pi openai-completions 的 supportsMidConvoSystemMessages，并仅保留已验证 DeepSeek V4.1 Flash 官方端点的窄特例。

目录按 provider 分组提供模型及 SDK 能力元数据（包含有效思考档位和预期缓存保留秒数），字段见 HTTP 契约；目录展示不改变叙事请求参数。目录的 narrativeCompatible 标记表示能处理包含中途 system 节点的叙事编排；标记为 false 的模型仍可能支持没有这种节点的具体请求。检测接口只发短文本，因此检测成功不等于任意预设顺序都可执行。

连通性检测使用已保存配置，单次请求的 maxTokens 传入 min(64, model.maxTokens)，整体等待上限 30 秒。仅返回 connected、providerId、modelId、durationMs 和标准 usage；不创建 entry/run、不回显模型回复或供应商错误文本，也不更新模型配置。具体路径见 [HTTP 契约](server-v2-http.md)。

## 停止、连接与关闭

POST 或 SSE 断开不取消叙事；只有显式 stop 或服务正常关闭触发本地取消。停止不等待供应商一定遵守 AbortSignal：本地消费者及时结束，忽略迟到结果，保存已收到的公开内容，发布一次总 usage 和终态。

服务正常关闭先停止受理，取消当前运行，等待本地结束保存和终态发布，然后关闭 SSE、HTTP 与数据库。强制结束进程时，已保存用户仍在；尚未进入结束保存步骤的内存公开内容可能丢失。不逐分片刷盘，不保留重启恢复记录。

实时事件只有 event/data，没有事件 id、确认或回放。断线或重启后以 entries/history 中已保存内容为准，不能从 202 或预分配助手 ID 推断生成完成。终态及字段定义见 [会话事件](server-v2-events.md)。

## 轮次查询与结束记录

叙事接口统一位于 `/api/v1/sessions/:id/narrative`，包含 runs 提交、五轮分页、单轮详情、停止与基础 usage 汇总；SSE 继续使用原会话 events 入口。列表返回完整 entries 分组：历史以 firstSeq 倒序，afterSeq 以新增条目对应的 lastSeq 升序。单轮详情将持久化结果与内存活跃记录组合，不保留已结束运行的内存缓存，不返回实时正文快照。

结束记录在用户 entry 的 extData.narrative，结构为 `{status:'completed',finishedAt}` 或 `{status:'stopped',stopReason,finishedAt}`。finishedAt 是 Unix 毫秒，stopReason 使用同一叙事原因枚举。用户尚未完成时不写该字段；助手保存失败仍尝试保存失败原因。结果写入失败保留已保存消息并以 message_persist_failed 发事件，没有结果且不活跃时查询返回 unknown。

通用 entry 编辑不能写入或清除 narrative，保存结果时保留其他扩展字段。metrics.requests 不再保存 status，增加 provider；旧 status 在读取时丢弃、未知 provider 为 null，新记录严格校验。usage 查询只合计已存 metrics 的已知部分并返回未知用量请求数，不宣称完整计费。

重连只补查已保存 seq；未落库分片不保证补齐，最终 snapshot 替换与终态后的持久化查询负责最终展示。仍活跃的轮次只提供 running/stopping 状态；用户 entry 的结束结果更新不增加 seq，客户端需另查原活跃轮次。接口字段见 [ServerV2 HTTP](server-v2-http.md)。
