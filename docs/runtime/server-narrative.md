# Server 叙事执行

## 能力与目录边界

Server 在现有会话上提供按预设整理上下文、可选一次摘要调用、一次正文调用、正文/公开 reasoning/工具请求增量和显式停止。用户受理时先保存；助手完整或部分公开内容在正常结束、失败或停止时独立结算。用户、成功摘要及助手各自保存，不使用跨模型调用的整体事务。SSE 只使用 Server 自有契约，外部仅发布一次 run 总 usage，异常终态仅使用 stop_reason。

Web 已接入管理、作者预览与文本叙事运行页，见 [运行接入](web-runtime.md)。原 Server/Web 保持独立。Server 处理正文尾部的状态 JSONL、行动建议数组和独立角色立绘 JSONL 快照；不提供 Agent/tool loop、修复重试、重启恢复、执行状态表或事件回放。

会话创建由独立 create-session 用例完成开局选择、{{user}} 替换、session/message 初始状态和首条 assistant 消息的一次事务保存，只发 session.created。首条消息是普通 run 分组的一部分，不分类；其正文参与后续历史，状态被后继继承。服务端按应用开局覆盖后的 message 快照逐根写入 extData.output.stateUpdate.updates，每行保存成功状态、根路径及完整值。有更新时状态为 success，空快照为 no_updates。行动建议保存为 no_suggestions 和空数组，模型请求计数为零。开局不自动创建持久立绘结果。

状态 HTTP 独立提供三个 scope 的 GET/PATCH/PUT。叙事后处理只更新本轮激活且已存在的 message 路径，不向模型开放 global/session 写入；公共 PATCH 的缺失路径忽略语义保持不变。state.changed 保持 `{path,scope,value}` 契约，在成功提交实际变化后发布；message 事件表示当前 tip 的有效继承视图。叙事有变化时保存完整助手状态快照，无变化时继续 null 继承；内部 getViews/evaluateWhen 服务于叙事上下文。具体写入与读取语义见 [状态接口](server-http.md#状态接口)。Web 的 state feature 与 Stage SDK 按这些路径和事件语义接入，写后读取权威状态，不乐观推导被忽略的值。

| 位置 | 职责 |
| --- | --- |
| `src/infrastructure/cache/index.ts` | 全应用共享内存写锁、持有者校验与解锁 |
| `src/usecases/narrative/index.ts` | 普通提交/重新生成准入、运行锁和执行身份、查询、停止与关闭 |
| `src/usecases/narrative/start.ts` | 用户就绪后的公共生命周期、唯一上下文入口、通知与释放锁 |
| `src/usecases/narrative/regenerate.ts` | 最新目标校验、删除及清除终态事务、提交后删除与状态回执 |
| `src/usecases/narrative/execute.ts` | 等待上下文结果、主模型及后处理、助手与状态保存、通知和总 usage/终态 |
| `src/usecases/context/index.ts` | prepareContext 唯一公开入口及显式公开类型 |
| `src/usecases/context/capture.ts` | 首次异步等待前通过公开 Service 冻结 session 当前消息、实际 tip 状态及配置 |
| `src/usecases/context/prepare.ts` | 会话上下文阶段编排、成功摘要保存、准备结果与已提交回执 |
| `src/usecases/context/candidate.ts` | 将历史投影、材料选择和真实消息编译组合为候选评估函数 |
| `src/usecases/context/capabilities.ts` | 同条件选择能力节点、模型目录及历史旁注来源 |
| `src/usecases/context/stages/history/`、`materials/` | 干净历史投影、完整 run 边界、候选材料激活 |
| `src/usecases/context/stages/model-notes/` | 条目旁注来源与选择，正文和旁注分离 |
| `src/usecases/context/stages/compact/` | 计划、旧摘要复用、摘要请求与执行、最终候选复核；不持久化 |
| `src/usecases/context/stages/assemble/`、`lib/` | 最终消息组装、输出协议、模板、输入估算与预算计算 |
| `src/usecases/narrative/model-call.ts`、`postprocess/` | 正文公开输出适配、独立标签提取、流式隐藏、能力校验及异常隔离 |
| `src/infrastructure/model/client.ts`、`collect.ts` | SDK 无关模型契约、collectModel/raceAbort、快照复制和调用指标；不依赖业务或事件传输 |
| `src/infrastructure/pi/` | 固定版本 pi 的 ModelClient 实现，内部转换 SDK 消息与结果 |
| `src/infrastructure/database/`、`events/` | 数据库连接/同步事务及 EventHub/SSE 传输 |
| `src/modules/sessions/` | entries、线性历史、指标和受控 output 的属主持久化 |
| `src/modules/state/` | 状态读取、继承、字段候选及受限 when 求值 |
| `src/usecases/set-state.ts` | 经属主 Service 保存快照或逐项字段写入 |
| `src/usecases/test-model.ts` | 已保存模型配置的一次短文本连通性检测 |

业务模块只通过 `service.ts` 提供能力；叙事用例不读取 Repository、存储行或 SQL，不接收数据库连接；装配注入同步 TransactionRunner，事务仅覆盖收尾读取、候选计算和助手保存，不包含模型/网络等待。用例、路由和编译器依赖自有 ModelClient/ModelInfo/ModelMessage，不接触 SDK Model、StopReason 或具体 PiClient；只在装配入口选择 PiClient 实现。pi 不依赖业务模块、会话、entry、EventHub 或 HTTP。装配方为叙事与 SSE 注入同一个 EventHub。context 生产代码不依赖 narrative、其他 usecase 或事件传输，只通过进度通知交由外层映射 run 事件；外部代码和类型只能从 context/index.ts 导入。

主叙事与滚动摘要请求均携带本轮接受时捕获的 modelParameters，包含可选温度、Top P、频率惩罚、存在惩罚，以及 thinkingEnabled 和可选 thinkingLevel。标准深度为 minimal、low、medium、high、xhigh、max；未指定时保持既有默认行为。pi 适配层依据当前模型的实际支持档位应用显式选择，不支持所选深度时仅忽略该选择并沿用原有默认深度，保持已开启的思考行为；关闭思考或模型不支持思考时不传 reasoning 参数。

### 采样参数发送规则

PiClient 按目录中的精确服务商、接口、端点、模型与思考模式决定用户覆盖。每一项单独校验，超出该路由范围、模式固定或能力未知时忽略该项，并通过开发日志的 sampling_omitted 记录原因。没有设置的键保留 SDK 和模型默认行为；不探测、不重试、不改写预设。实际 SDK payload 继续由只读诊断记录。

| 当前已验证的路由 | 可发送的用户覆盖 |
|---|---|
| OpenRouter 的 openai/gpt-4o-mini，Chat Completions | 四项均支持，包含显式 0。[路由端点能力](https://openrouter.ai/api/v1/models/openai/gpt-4o-mini/endpoints) |
| DeepSeek 官方 V4 Pro | 非思考模式可调温度及 (0,1] 的 Top P。思考时四项覆盖均省略。[参数说明](https://api-docs.deepseek.com/api/create-chat-completion/) |
| DeepSeek 官方 Flash | 非思考模式可调温度；思考模式可调 [0.95,1] 的 Top P。[模式说明](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/) |
| OpenAI 官方 Responses，API Key | 目录内 GPT-4o、4o mini、4.1、4.1 mini、4.1 nano 支持温度和 Top P；GPT-5.2／5.4 仅在有效 effort 为 none 时使用这两项。[模型参数兼容性](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4) |
| Google 原生 Gemini 2.5 Flash、Flash-Lite、Pro | 当前 Pi 原生调用通道传递具名温度。 |
| Anthropic 原生 Haiku／Sonnet／Opus 4.5、Sonnet／Opus 4.6 | 固定 SDK 使用的旧版协议在关闭思考时可传 [0,1] 的温度。已登记的快照 ID 见适配器。 |

pi-ai 1.5.0 的 OpenAI 兼容适配器在模型及思考档位默认值之后合并请求的 samplingParams。原生适配器按已实现的具名选项传递。升级 SDK、改变 API 版本或路由端点时，需复核映射和最终请求体。

## 提交与结束

1. HTTP 检查来源、真实会话和可选访问权限。用例检查输入非空白、expectedTipEntryId、同会话并发和停机状态；拒绝的请求不追加消息。
2. 首次 await 前占用当前会话，生成 runId、userEntryId、assistantEntryId。用户消息立即追加到请求指定的前驱；写入失败则不受理、不调用模型。
3. 用户保存后仅传 sessionId 及执行控制参数调用 prepareContext；其同步部分在首次异步等待前捕获 session 当前领域快照。Context 自行识别末尾用户消息并映射 input.text，message 状态从实际 tip 读取；普通发送保存的用户 state=null，继续继承此前状态。上下文准备失败作为本轮执行错误处理，已经保存的用户消息保留。
4. 返回 202 及受理标识、已保存的 userMessage，发布携带同一用户消息的 run.created；客户端可按 HTTP 响应立即展示，SSE 按消息 ID 确认或补偿。后续上下文准备包括模型预算、候选评估、顺序检查和可选一次摘要。context 编排器独立保存成功摘要并回传准备结果、后续父节点和摘要回执；外层取得可用请求后调用正文模型。摘要进度必须在 run.created 后，保存成功后才发布 run.summarized。尚未取得模型配置时 provider/model 为 null。
5. 模型 content 经流式分离后映射为 run.delta，能力块保持隐藏；公开 reasoning 和工具参数继续独立累积。最终模型快照重新分离，干净 snapshot 权威替换公开内容，不要求与之前 delta 拼接完全一致。没有增量时也可输出最终快照。
6. 模型结束、错误、输出不完整或停止都进入保存步骤。仅正常 stop、无工具请求且干净正文有效时执行后处理，分别记录能力结果并准备 message 状态候选。助手正文、output、state 和 metrics 同步事务保存；部分助手保存公开内容但不生成 output。parentId 为成功 compaction ID，没有摘要时为 userEntryId；完全没有公开内容时不造空助手。
7. 保存助手后将结束结果写入用户 entry 的 extData.narrative，再释放当前会话占位，发布已提交状态变化及有效建议，然后发布唯一一次 run.usage 和唯一终态。每条能力通知异常独立隔离，继续后续通知和终态。stop_reason 区分取消、关闭和主流程失败，保存失败优先；能力错误只留在 output，不改正常 run.completed。

同会话同时只允许一轮，冲突返回 RUN_ALREADY_ACTIVE/409，不排队；不同会话独立执行。services.ts 装配的 RuntimeCache 在全应用共享，用户保存前加锁，覆盖摘要、正文、后处理和结算；失败/取消/关闭均释放。会话编辑、删除、手工追加、正文/扩展/计量/结束结果写入返回 SESSION_WRITE_LOCKED/409；session/message 状态写入及该世界任意 run 活跃时的 global 状态写入返回 STATE_WRITE_LOCKED/409，空 PATCH 和同值也不例外。内部本轮持有者令牌只授权消息、摘要和结束结果落库，不向外部事件订阅者传播。结算完成、通知之前解锁，finally 按对象身份幂等释放，避免覆盖新 run。active Map 仅保留停止/查询所需的执行句柄；读取、SSE、stop 不受写锁影响。不提供多进程锁或可恢复任务存储。

run.completed 要求模型正常 done、finishReason=stop、无工具请求、正文非空且助手写入成功。叙事正文请求因 length 截断时按 output_limit_reached 结束，舞台提示调高当前预设的「最大输出长度」。deferred 或缺少终态仍按 output_incomplete 结束；工具请求按 tool_execution_unsupported 结束；只有 reasoning 的正常结果仍保留但不视为完整正文回答。SDK 最终结果可以修正增量，明确的 snapshot 使用替换语义。模型消息 finish 与 run 持久化成功分开：生成正常而保存失败，最终仍为 run.stopped。

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

entry.role 与 payload.message.role 一致。同轮已有消息共享 runId；requestId 是一次模型请求的标识，不是请求去重键或事件 ID。助手 state 无变化时为 null，有实际变化时保存完整更新快照；正常执行后处理的助手 extData.output 保存各能力结果，模型未正常完成的部分助手不制造 output。用户 extData 在结束结算后包含 narrative。公开 reasoning 和工具请求与正文同属消息内容；不保存 SDK signature、redacted 数据、供应商原始响应、API key 或 SDK AssistantMessage 整体。工具参数保留字符串，包括中断时的不完整 JSON，不解析或执行。

| 结束情况 | 保存结果 |
| --- | --- |
| 完整生成并保存成功 | 用户 + 完整助手快照，用户 narrative.status=completed |
| 模型失败或输出截断，已有公开内容 | 用户 + 助手公开快照，用户 narrative.status=stopped，stopReason 为失败原因 |
| 主动停止或正常关机，已有公开内容 | 用户 + 助手公开快照，用户 narrative.status=stopped，stopReason 为 cancelled/server_shutdown |
| 只有 reasoning 或工具请求 | 保存公开快照；无正常正文或不支持的工具执行以相应 stop_reason 结束 |
| 配置、凭据、预算等失败，或没有公开内容 | 仅用户；不生成空助手 |
| 助手写入失败或 tip 冲突 | 保留用户，savedMessageIds 不包含预分配助手 ID，不宣称已保存 |
| 只有空白正文和 reasoning、没有工具请求 | 不创建助手消息 |

失败或停止的部分消息是正式可读记录，下一轮只读取其可见正文。只有 reasoning/tool_calls 而没有正文的助手记录不生成伪空模型历史，记录及真实前驱/tip 仍保留，状态从捕获时真实 tip 的有效视图读取。正文计量随助手保存，完全没有可保存助手时没有历史指标载体；实时 run.usage 仍按规则发布，这些指标不是完整账单。session.usage 不累加。

内部 usage 为 `{inputTokens,outputTokens,totalTokens,cacheReadTokens,cacheWriteTokens}` 或 null，SSE run.usage 映射为 snake_case。输入总量包含缓存：inputTokens=input+cacheRead+cacheWrite；cache 字段是输入细分，reasoning 已计入输出时不再次相加。没有 SDK 调用尝试时总量为真实零；尝试后无可信上报、字段无效或总量口径不一致时为 null，不把 SDK 初始零值当作已上报零。每个 accepted run 只发布一次结算总量，不带 messageId/requestId，也不在停止后等待或补发迟到统计。总量为成功保存摘要的调用用量加正文调用用量，任一参与统计的调用 usage 未知则总量为 null。失败/中断摘要既不保存记录也不计量；只有失败摘要而无正文调用时总量为零，允许与供应商实际消耗存在误差。

## 上下文与首版能力

世界、玩家身份、预设和模型绑定来自当前会话的 worldId、userCharacterId、presetId 和 apiModelConfigId，不因应用默认项更新而切换；输出语言另取应用设置 locale。快照在凭据或模型异步等待前完成，本轮不受后续配置、语言或消息内容编辑影响。

只接受合法的 user/assistant 历史消息，payload.message 的角色须与 entry.role 一致，content 为文本、timestamp 为有效非负数。兼容原来的纯正文 payload；reasoning/tool_calls 不进入正文投影、材料关键词扫描或模型提示词。compaction 独立于普通正文投影；rolling_summary 从新到旧查找覆盖边界与 sourceHash 有效的摘要，忽略无合法元数据、来源被修改或覆盖受保护末轮的摘要；无有效摘要时回到完整原文。实际 tip 为 null 或没有继承消息快照时，message 视图为空；叙事提交不重复初始化 opening，新会话已由创建用例保存首条消息及状态。

角色与世界书保留 load.mode、keywords、keyword_logic、exclude_keywords、when 及 order 语义。角色通过 load.mode=never 禁用；世界书条目还支持 enabled=false。角色卡协议没有角色 enabled 字段，导入不会保留该字段。匹配区分大小写，扫描本次保留的历史叙事、有效摘要与当前输入；每个裁剪候选重新激活材料，不假定 token 估算随裁剪单调递减。用户系统指令块不用于触发关键词。when 通过 StateService 对已捕获的 global/session/message 视图进行受限 AST 求值，不执行任意 JavaScript，也不写状态。

预设节点按原顺序编译。history.messages 展开为原角色消息，自定义文本节点保留位置和角色；最新普通消息为 user 时，该消息从 history.messages 的投影中移至 input.text，只在 userInput 节点插入一次；尾部 compaction 不改变这一判定。最新普通消息为 assistant（包括无可见正文的部分输出）或会话为空时，input.text 为空，userInput 节点不产生消息，即使节点包含包装文字；之前的用户消息仍留在历史原位置。预设模板支持固定变量、状态字段路径与原有转义，未知变量和非法路径仍报错。

预设节点和已选中的玩家/NPC prompt、世界书 content 支持 `{{state.<global|session|message>.<路径>}}`：从本轮捕获视图逐段读对象自有属性，只能读取当前裁剪候选按 load 激活的根，不增加写授权。字符串原样填入（作者素材保留原有正文转义），其余值输出紧凑 JSON；缺值或不可见根留空。世界卡导入不检查变量；作者素材中非法的闭合 state 路径留空，不支持的自定义变量和未闭合正文原样保留。只扫描源字段，输入、历史、替换结果和最终消息均不再扫描；状态规则、开局、摘要提示不新增插值。

worldState、actionSuggestions、characterSprite 按固定相对顺序声明。PresetService.resolvePostprocessPrompts 只返回实际存在且 enabled=true 的节点，不补缺失节点、不替换空提示词、不读取旧变量别名。启用能力节点的空提示词在保存/导入时拒绝；模板编译失败明确报错，无默认回退。默认正文来自发行模板或用户显式恢复默认。main 使用遵守本轮实际构建能力的通用措辞。

worldState 在已启用且任一作用域有适用状态材料时参与。预设模板的 `{{state.global}}`、`{{state.session}}`、`{{state.message}}` 分别应用世界卡加载条件，缺失快照值标为未设置。global/session 是只读背景；只有最终激活的 message 根用于后处理路径授权，与是否有 rules 无关。仅有可写根时构建 state_update 输出协议；只提供已声明规则，不要求覆盖。actionSuggestions 需要实际启用的节点。

characterSprite 还要求世界目录非空。context 首次异步等待前捕获全卡已声明的合法素材，角色 load 只控制角色 prompt，不裁掉立绘目录；成功 request.characterSpriteCatalog 无论节点是否启用都保留，供实际输出校验。正式变量 `{{characterSprite.catalog}}` 只在立绘条件成立时提供角色 ID/姓名、素材 ID/说明、当前玩家角色 ID，不含 asset 地址、完整角色 prompt 或图片。该变量可用于其他预设节点，但关闭或缺失立绘节点时值为空。条件同时控制立绘节点、固定协议和历史来源；详情见 [预设创作](../creator/presets-and-models.md) 与 [世界卡协议](../reference/world-card.md)。

### 叙事输出语言

应用设置保存 `locale: "zh-CN" | "en" | "ja"`，默认简体中文。context 通过 SettingsReader 在首次异步等待前捕获 locale，与本轮领域快照一起固定；裁剪、摘要完成后的候选重建都使用该值。运行过程中切换语言只影响下一次上下文准备，发送和重新生成共用此行为。语言不写入会话、消息或世界状态，不翻译已有历史及摘要。

预设节点可插入 `{{system.language}}`，分别替换为 `简体中文`、`English` 或 `日本語`。新的标准叙事 main 已包含叙事正文和面向用户自然语言的语言要求，已有预设保持原文与 revision，需要时在编辑器插入变量或恢复该节点默认内容。世界作者素材只保留原有 user/state 插值边界，历史和替换结果不再次解析此变量。摘要提示词仍按原方式直接使用，不新增变量展开。

自然语言输出可以切换；协议标签、JSON 字段名、状态路径、约定状态取值保持原义。语言切换本身不产生状态更新，状态值仍依据事实与作者规则处理。

### 唯一上下文入口

调用方只使用 context/index.ts 的 prepareContext(dependencies, input) 和显式公开类型，不读取内部 capture、candidate、lib 或 stages。业务输入只有 sessionId；signal、可选 writePermit/onProgress 属于执行控制。入口不接收 kind、runId、userEntryId、previousTipEntryId 或 inputText，不判断调用来源，也不保存用户消息。准备结果包含最终模型请求、最终激活状态根、后续 parentEntryId、已提交摘要回执和准备失败信息；摘要草稿不会交给外层叙事保存。context 编排器经公开 Service 完成摘要持久化，外层负责主调用、run 事件及终态。

compact 阶段通过候选评估函数重复选择材料、组装最终消息和估算，不把阶段固定为各执行一次的流水线。每个候选都从捕获的干净输入重建；真实摘要复核失败时仍返回成功摘要草稿，保存后将摘要回执与失败一起交还，避免丢失已成功摘要的父链和计量。摘要端口不依赖叙事模型调用适配、正文分离或 SSE。

PreparedContext 以 ok 判别，成功返回 request 和独立的 diagnostics，失败返回 failure.code；两种结果都有 parentEntryId 和可选 summary:{entryId,metrics}。parentEntryId 表示捕获的实际 tip 或本次新保存摘要的 ID；空会话或尚未捕获成功时为 null。读取构建使用同一快照，摘要持久化前同步复核实际 tip 与原文指纹；发生变化返回 TIP_CONFLICT，不写入过期摘要。request 包含 credentialRef 和本轮完整 characterSpriteCatalog，不包含 API key；素材目录与本轮模型输入使用同一捕获版本。本轮摘要与正文的凭据读取在 narrative 闭包内复用，不进入上下文返回值或数据库。

narrative/index.ts 先排入执行微任务，再同步调用 prepareContext；入口在首次 await 前捕获领域快照及应用语言，后续准备发生在 run.created 之后。内部进度 summary_started 在凭据就绪、摘要实际调用前发出，summary_saved 在成功保存后发出；外层映射到既有 run.summarizing/run.summarized。

### 条目级模型旁注

model-notes 构建按 entryId 关联的独立内存数据，历史正文始终不变。叙事内置状态更新、行动建议、角色立绘三个独立来源；节点与材料条件同当前 prompt，未启用或无适用材料的来源不附块。其他来源失败独立隔离；立绘 source 内部捕获读取、校验和序列化异常，仍返回完整空标签。

在本轮已捕获历史中先选择最近两条有可见正文的 assistant，再分别读取对应 extData.output；没有结果不继续向更早消息补足。状态来源只取成功 updates 的 path/value/reason，建议来源只取有效 items；立绘来源只序列化该消息 success/partial_success 的完整有效 items，不注入行状态、错误诊断或原始失败行。每个裁剪候选重新核对来源条件，窗口始终来自同一份捕获历史。

| 消费方 | 输入投影 |
| --- | --- |
| 材料激活 | 干净正文、有效摘要及当前输入 |
| 摘要模型 | 干净正文，继续去除玩家 instruction |
| 主模型 | 干净正文及最终保留条目的旁注 |
| 输入预算 | 实际发送的最终消息，包含旁注 |

只有候选最终保留的 entry 才渲染旁注；滑窗删除或被摘要覆盖后，旁注随条目移除。每次从干净正文开始，正文与首个数据块间空一行，随后按 state_update → action_suggestions → character_sprite 顺序仅追加启用来源，各块间一个换行。启用来源无有效数据时，状态为零行 JSONL，建议为单行 []；立绘缺失、空数组、失败或损坏均为 `<character_sprite></character_sprite>`。关闭立绘节点或目录为空时连空标签也不附。JSON 字符串中的保留标签继续转义。

正文编辑保留已保存 output；旁注表示当时的处理记录，不表示依据编辑后的正文重新校验。旁注不回写历史、不把缺失/失败结果改成成功、不重执行更新、不触发状态或立绘事件，也不进入公开聊天、摘要或关键词。无需 notes 表、持久化 schema、contextEligible 或历史重建 API；原文 sourceHash 不包含动态旁注。

### 自动裁剪与滚动摘要

按 entries.runId 划分完整轮次，首条开场 assistant 和只有用户的失败轮次均正常计数。优化阶段接收全部有效 entries。若最新普通消息为 user，则保护其整个 run（包括该 run 更早的条目），不允许滑窗裁剪或摘要覆盖；不依赖调用方提供“当前输入”。最新普通消息为 assistant 或会话为空时，不虚构待回复输入。仅有 reasoning/tool_calls 的记录不成为模型正文，但仍参与完整轮次边界；交错 runId 不允许被拆开。

- sliding_window：从最旧完整 run 开始移除模型输入中的历史，选择符合软目标的最长连续后缀；达不到软目标则使用符合硬预算的最长候选。允许移除全部旧历史，不删除或改写数据库条目，不生成摘要，也不复用旧摘要替代原文。
- rolling_summary：复用有效旧摘要及未覆盖原文，保护最近 5 个历史 run，末尾受保护的用户 run 另计；选择更早的完整前缀，必要时与旧摘要合并生成一份摘要。摘要输入排除玩家指令区段，不携带 reasoning/tool_calls。每次构建最多一次摘要，不为单独重写旧摘要发起调用；无可压缩前缀且超限时报 summary_capacity_exceeded。
- history.summary 单独承载摘要，history.messages 只承载未覆盖原文，移至 input.text 的末尾用户消息不重复出现。rolling_summary 要求启用的非后处理模板中恰好出现一次 history.summary，否则 invalid_context；不修改已有预设文档。后处理提示词不能引用 input.text、history.messages 或 history.summary，编译拒绝这类引用，防止当前输入、历史消息或摘要重复注入。摘要与保留原文重新参与材料激活。
- 摘要和正文共用本轮模型与凭据。摘要只接受正常 stop、非空正文且无工具请求的最终快照；允许最终快照修正之前增量。摘要失败/截断/中断不保存任何摘要记录及指标，不生成空 compaction。
- compact 使用真实摘要复核最终候选，同时保留成功摘要草稿，即使最终预算或编译失败也不能丢失草稿。context 编排器独立保存成功摘要后才发布 run.summarized，返回实际 parentEntryId 与计量回执。不超过硬预算即可继续；仍超限直接 summary_capacity_exceeded 结束，保留用户、完整摘要及其 metrics。不再次摘要、不额外裁剪、不切换策略。

成功摘要追加到捕获的实际 tip 后，归属该 tip 的 run；普通发送时仍与 user/assistant 同 run：

```ts
{
  type: 'compaction', role: null, parentId: capturedTip.id, runId: capturedTip.runId,
  payload: { summary: '完整摘要正文' }, state: null,
  extData: { summary: { coveredThroughEntryId, sourceHash } },
  metrics: { requests: [{ requestId, provider, modelId, usage, durationMs, firstTextMs? }] }
}
```

sourceHash 为覆盖前缀内全部 message 的 id/seq/runId/role/content 规范化 JSON 的 SHA-256，排除 state、metrics、时间戳、compaction 和动态模型旁注；覆盖到完整 run 边界。用于摘要复用时识别历史编辑，保存前也比较完整捕获消息的同规则指纹；不是请求指纹或恢复机制。首次存储 summary 时，coverage 是全部覆盖范围而非仅本次新增前缀。状态仍读取实际 tip 的有效继承视图，不从摘要重建。

成功摘要的 usage 可以为 null；失败或中断摘要无记录、无计量。正文 metrics 仍属于 assistant，user.metrics 为 null，不重复计数。HTTP 通用追加禁止 compaction，通用编辑禁止修改摘要 payload/extData 或在普通消息伪造 summary 元数据。摘要只经 context 编排器调用 SessionService 保存，compact 阶段不写库。

普通发送的物理顺序为 user → 可选 compaction → 可选 assistant；独立上下文构建也允许在 assistant 或既有 compaction 后保存新摘要，各自分配 seq，父链和 tip 原子推进。savedMessageIds 仅列 message，实际 tipEntryId 可能是 compaction；五轮分页与 afterSeq 返回的完整分组包含摘要记录。摘要正文不作为聊天 delta 推送。

### 预算和生成参数

读取预设 maxContextTokens、maxOutputTokens 及 modelParameters。请求中的 maxOutputTokens 必须为正且不超过模型目录 maxTokens；本地输入预算为：

```text
B = min(preset.maxContextTokens, model.contextWindow - preset.maxOutputTokens - 1024)
T = floor(B * 60%)
```

输入预算非正返回 INVALID_MODEL_BUDGET。估算达到 B 时整理；T 是软目标，B 是硬上限。滑动窗口无法满足 B 返回 context_budget_exceeded；摘要输入超限、无可压缩前缀而超限或一次摘要后仍超限返回 summary_capacity_exceeded。没有可整理历史且恰好等于 B 时允许生成。粗估与实际计费用量分开，不建立 usage 校准或请求指纹。供应商拒绝实际窗口超限时返回对应失败，不重试、不删历史。

后处理按模型实际输出处理，不单独分配能力 token、更新条数或全尾部大小配额；usage 包含隐藏数据块，不按可见正文长度重算。单值 JSON/类型/深度错误局限于相应更新行或能力。输入预算仍按上述模块执行。

maxOutputTokens 交给 pi 既有预算映射，供应商实际输出参数可能因 thinking/context 调整；这不是对供应商总输出参数的精确保证，上下文整理按上述输入预算执行。thinkingEnabled 开启且目录模型支持 reasoning 时请求 medium；关闭时沿用 pi 的默认映射，能否完全关闭取决于 SDK 对该模型的能力描述。

摘要输出上限 S=min(2048, model.maxTokens)，摘要输入上限 min(floor(model.contextWindow*75%), model.contextWindow-S-1024)。它是独立辅助调用预算，可以大于主叙事 maxContextTokens；超出时不发起调用、不分块重试。采样与思考配置沿用本轮预设。

## 叙事后处理与能力结果

正常正文末尾可包含：

```text
<state_update>
{"path":"coins","value":8,"reason":"购买食物"}
{"path":"inventory.soup","value":1}
</state_update>
<action_suggestions>["继续询问店主。","","离开酒馆。"]</action_suggestions>
```

每个能力独立匹配、校验自己大小写不敏感的起止标签，不读取预设或 enabled。状态/建议缺块或空块是正常无结果；立绘缺块不创建结果，完整空块是明确的成功空快照。自身标签损坏、嵌套、配对错误或重复整块为 invalid_tag，该能力不执行数据。其他能力不作为边界或恢复锚点，继续独立匹配；JSON 字符串中的标签使用 Unicode 转义，正文使用 HTML 实体。

流式隐藏无条件识别三种保留能力标签，不依赖预设开关；缓冲未完成标签前缀，支持跨分片和 UTF-16；最终快照再次分离。postprocess 仅解析 content，不从 reasoning/tool_calls 执行能力，摘要调用不启用此流程。

### 状态更新

state_update 为 JSONL，每个非空物理行一个完整对象，兼容单行标签包单对象。不接受外围数组，一条更新不能跨物理行。每行独立解析、校验、规范化并接受候选；失败不改变该行前的候选，保留其他成功行和非目标状态。仅 message scope、最终激活根及已有路径；value 完整替换，同值也成功，实际未变不发布事件。

| 整体 status | 含义 |
| --- | --- |
| no_updates | 标签缺失或为空 |
| success | 更新全部有效 |
| partial_success | 标签完整，有成功行也有失败行 |
| invalid_updates | 有内容但更新全部无效 |
| invalid_tag | 自身标签损坏，整个状态能力不执行 |
| processing_error | 状态材料或能力计算异常 |

stateUpdate 只使用一份 updates，按输入行序保存全部成功/失败记录。每项 status 为 success、invalid_json、invalid_update、invalid_path、invalid_value、processing_error；成功项必须有 path/value，可含 reason，失败项保留可用的 path/value/reason 及稳定错误码、statePath/rulePath，不虚构无法解析的字段。不再保存 results，也不含 blockIndex/line/index。

### 行动建议

action_suggestions 保持 JSON 数组。每项 trim、验证字符串及 50 个 Unicode 码点长度，去重；空白和其他无效项直接过滤，保留有效 items。三条仅是提示词目标，不因最终不足三条整组失败。

整体 status 为 no_suggestions、success、partial_success、invalid_tag、invalid_json、invalid_suggestions、processing_error。缺失/空标签或 [] 是 no_suggestions；有有效项也有无效项为 partial_success，非空数组中的条目全部无效为 invalid_suggestions。结果只保存 status、items 和可选能力级 errors，不保存逐项 results。

### 角色立绘

立绘是独立服务端能力，与视觉小说和前端左右布局无关。模型每轮输出最新完整快照，每个非空数据行是只有 position、characterId、spriteId 的扁平对象：

```text
<character_sprite>
{"position":"left","characterId":"alice","spriteId":"smile"}
{"position":"center","characterId":"bob","spriteId":"default"}
{"position":"right","characterId":"carol","spriteId":"serious"}
</character_sprite>
```

position 允许 left、center、right、top、topleft、topright、truecenter。同一快照中角色与位置分别唯一，因此可展示 3～7 个角色，不受两侧组件限制。按非空行序独立执行严格 JSON、字段、目录引用、位置和唯一性校验；先检查重复角色，再检查重复位置。第一条完整合法行保留，后续冲突行跳过；失败行不占用角色或位置，不覆盖已接受行。原始 JSONL 不设额外行数上限。

| 输入 | characterSprite 结果 | 变化通知 |
| --- | --- | --- |
| 无标签 | 无该字段 | 不发 |
| 完整空标签或只有空白 | success，items=[] | 发空快照 |
| 所有非空行通过 | success，items 为全部接受项 | 发完整快照 |
| 部分通过 | partial_success，items 为接受项，errors 记录失败行 | 发完整接受项快照 |
| 非空且全部失败 | invalid_items，items=[]，errors 为行诊断 | 不发 |
| 自身标签错误 / 能力级异常 | invalid_tag / processing_error，items=[] | 不发 |

错误项结构为 `{errorCode,line?}`；line 从 1 开始计算非空数据行，空白行不占号，能力级错误可不含 line。结果只保存有效 items 和诊断，不保留重复 updates/results 或完整原始行列表。`[]` 不是合法 JSONL 对象，也不是空标签别名。

success 和 partial_success 的 items 都是一份完整新快照；前一条消息中缺席的角色不会被补回。明确空标签 `<character_sprite></character_sprite>` 表示清场；全部失败的空数组只表示没有可应用结果，消费者须结合 status 判断。两者在已启用的历史来源中均可投影为空标签，历史投影本身不发布清场事件。

### 保存、失败与历史

各能力独立异常边界，状态和立绘内部逐行隔离。正常叙事的能力失败不改变 completed；模型错误、取消、length、工具请求或正文无效不执行能力，部分助手无 output。读取状态材料失败不能阻止建议、立绘与正文保存。

SessionService.appendNarrativeAssistant 将干净正文、extData.output、可靠状态候选和 metrics 原子追加。主流程在同一收尾事务中校验 tip、计算候选并预计算有效状态变更，再保存助手；不逐行写库或提前通知。成功项已提交时，即使状态为 partial_success 也发布实际变化。主流程存储失败仍按既有规则结算，不承诺数据库整体不可用时 completed。

run outcome 独立保存失败时，助手及已提交能力结果不回滚；实际状态和可应用立绘仍通知，本轮不发布可点击建议。正常事件顺序为提交、释放锁、state.changed、符合条件的 action_suggestions.created、character_sprite.changed、总 usage、唯一终态。立绘事件携带 sessionId/runId/messageId/items，success/partial_success 每次都通知，success 空数组也通知；无块、全坏行、标签错误或处理异常不发立绘事件。通知异常分别隔离，完整字段见 [会话事件](server-events.md)。

公共追加/编辑禁止写入或删除 output，编辑其他 extData 保留它；正文编辑保留当时结果，不重做或回滚。新 output 严格使用精简结构；既有 state/action 格式仍只在 SessionService 读取投影时归一化，不重写存储。立绘保存结构损坏时投影为 processing_error、items=[]、错误码 CHARACTER_SPRITE_STORED_RESULT_INVALID；不存在该字段时保持缺失。读取只验证保存结构，不依据最新素材目录改写历史合法 ID。结果随 narrative/runs 的 entries 返回，另有立绘目录和指定消息的只读 GET，见 [立绘查询](server-http.md#立绘查询)；无新表、列或能力运行状态缓存。

聊天、持久化正文、关键词激活与摘要保持干净。主模型的保留历史由 context 在最终组装时附加条目级 model-only notes，读取历史或旁注不重执行更新；规则见[条目级模型旁注](#条目级模型旁注)。没有持久化 notes schema、contextEligible 或能力专用历史重建模块。

## 模型与连通性

PiClient 实现项目自有 ModelClient，固定使用 `@earendil-works/pi-ai@1.5.0`。SDK 导入限制在 infrastructure/pi 内，原始 Model 不离开适配器；resolve 对外返回自有安全 ModelInfo，调用时在适配器内按 providerId/modelId 精确解析。未知模型失败；显式传入凭据与 AbortSignal，maxRetries=0，不传 tools。

适配器将 SDK text/thinking/toolcall 事件转换为自有 delta。contentIndex 映射为消息内工具序号；工具 ID/名称允许晚到，最终参数由 SDK 权威结果转换为字符串，不能把 partial 参数对象反复 stringify 后追加。done/error 返回独立公开快照；SDK partial 是可变对象，不直接跨边界暴露。公开 reasoning 不包含内部签名或 redacted 数据；工具执行循环与 SDK 私有回放数据的持久化不在本期。

编译结果含中途 system 消息时，仅在适配明确支持保持其位置时调用。不会把中途 system 全部前移以适配模型。兼容性取 pi openai-completions 的 supportsMidConvoSystemMessages，并仅保留已验证 DeepSeek V4.1 Flash 官方端点的窄特例。

目录按 provider 分组提供模型及 SDK 能力元数据（包含有效思考档位和预期缓存保留秒数），字段见 HTTP 契约；目录展示不改变叙事请求参数。目录的 narrativeCompatible 标记表示能处理包含中途 system 节点的叙事编排；标记为 false 的模型仍可能支持没有这种节点的具体请求。检测接口只发短文本，因此检测成功不等于任意预设顺序都可执行。

连通性检测使用已保存配置，单次请求的 maxTokens 传入 min(64, model.maxTokens)，整体等待上限 30 秒。仅返回 connected、providerId、modelId、durationMs 和标准 usage；不创建 entry/run、不回显模型回复或供应商错误文本，也不更新模型配置。具体路径见 [HTTP 契约](server-http.md)。

## 停止、连接与关闭

POST 或 SSE 断开不取消叙事；只有显式 stop 或服务正常关闭触发本地取消。停止不等待供应商一定遵守 AbortSignal：本地消费者及时结束，忽略迟到结果，保存已收到的公开内容，发布一次总 usage 和终态。

服务正常关闭先停止受理，取消当前运行，等待本地结束保存和终态发布，然后关闭 SSE、HTTP 与数据库。强制结束进程时，已保存用户仍在；尚未进入结束保存步骤的内存公开内容可能丢失。不逐分片刷盘，不保留重启恢复记录。

实时事件只有 event/data，没有事件 id、确认或回放。断线或重启后以 entries 或 narrative/runs 中已保存内容为准，不能从 202 或预分配助手 ID 推断生成完成。终态及字段定义见 [会话事件](server-events.md)。

## 轮次查询与结束记录

叙事接口统一位于 `/api/v1/sessions/:id/narrative`，包含 runs 提交、每页最多五轮的游标分页、停止与基础 usage 汇总；SSE 继续使用原会话 events 入口。列表返回完整 entries 分组：历史以 firstSeq 倒序，afterSeq 以新增条目对应的 lastSeq 升序。每个列表项将持久化结果与内存活跃记录组合，不保留已结束运行的内存缓存，不返回实时正文快照。

结束记录在每个 run 首条 entry 的 extData.narrative（普通叙事为 user，创建会话时为 assistant），结构为 `{status:'completed',finishedAt}` 或 `{status:'stopped',stopReason,finishedAt}`。finishedAt 是 Unix 毫秒，stopReason 使用同一叙事原因枚举。用户尚未完成时不写该字段；助手保存失败仍尝试保存失败原因。结果写入失败保留已保存消息并以 message_persist_failed 发事件，没有结果且不活跃时查询返回 unknown。

通用 entry 编辑不能写入或清除 narrative/output，修改其他 extData 时保留服务端结果；正文编辑不重新执行能力。metrics.requests 不再保存 status，增加 provider；旧 status 在读取时丢弃、未知 provider 为 null，新记录严格校验。usage 查询合计已存 metrics 的已知部分并返回未知用量请求数，不宣称完整计费；同时返回 latestContext，取最新已保存主叙事 assistant 请求的真实输入量、请求时模型窗口、配置与字节组成。execute 只在实际调用 metrics 存在时附加 context，摘要不参与 latestContext 选择。配置/模型改变或条目的 seq 超过当前 tip标记 stale；旧数据缺字段保持未知，不借用上一轮数据。组成含 UTF-8 文本和 V1 约定每消息 16 B 开销，系统/摘要/历史字节不是逐类计费 Token；完整字段见 HTTP 契约。

重连只补查已保存 seq；未落库分片不保证补齐，最终 snapshot 替换与终态后的持久化查询负责最终展示。仍活跃的轮次只提供 running/stopping 状态；用户 entry 的结束结果更新不增加 seq，客户端需另查原活跃轮次。接口字段见 [Server HTTP](server-http.md)。


## Run 单行日志

叙事默认写入进程 stdout，每条观测一次输出，格式为 `[yyyy-MM-dd HH:mm:ss] [事件] [JSON对象]`。时间使用服务器本地时区；JSON 紧凑序列化，正文换行与 Unicode 行分隔符转义，长正文不截断。每条数据固定以 runId/sessionId 开头，同一 run 的摘要、主模型、后处理和结算可按 runId 筛选；不同会话可以正常交错，不等 run 结束后才批量输出。

```text
[2026-11-20 18:30:00] [run.created] [{"runId":"r-1","sessionId":"s-1","messages":[{"id":"u-1","role":"user","content":"购买食物\n询问店主"}]}]
[2026-11-20 18:30:01] [state_update.raw] [{"runId":"r-1","sessionId":"s-1","messageId":"a-1","tagStatus":"present","blocks":["\n{\"path\":\"coins\",\"value\":8,\"reason\":\"购买食物\"}\n"],"source":"block_contents"}]
[2026-11-20 18:30:01] [postprocess.completed] [{"runId":"r-1","sessionId":"s-1","messageId":"a-1","persisted":true,"stateChanged":true,"suggestionCount":3}]
```

示例只展示格式及部分字段；实际日志保留对应事件或处理结果的完整字段。

| 事件 | 数据 |
| --- | --- |
| `run.created` | 已保存的用户消息全文和标识、provider/model；受理后立即记录，先于同步停止请求 |
| `context.completed` | 最终选用候选的所有节点名称、启用/加入结果、来源及最终消息位置；角色和世界书名称、配置条件、实际关键词/排除词/when 结果及原因；激活根、消息数、估算输入与预算 |
| `context.failed` | 实际准备失败代码、当前父 entry 和已保存摘要 ID，不宣称构建完成 |
| `run.summarizing` / `run.summarized` | 摘要开始及真正保存后的回执 |
| `model.request` | `purpose:summary\|narrative`、实际 provider/model、`source:provider_payload` 与 SDK 发送前钩子取得的真实请求体 `raw` |
| `model.response` | 相同调用归属及完整 `raw`；`sdk_message` 为归一化前的最终 SDK 消息，`sdk_error` 为 SDK 错误消息，`adapter_error` 表示取消、抛错或缺失终态 |
| `postprocess.started` | 处理的助手 ID 和本轮允许更新的状态根 |
| `state_update.raw` / `action_suggestions.raw` / `character_sprite.raw` | 自身标签状态和未经 trim 的原始块内容；坏标签保留完整模型原文并标记 `source:unparsed_model_output`，不会据此恢复执行 |
| `state_update.result` / `action_suggestions.result` / `character_sprite.result` | 完整能力状态、有效更新/建议、每行/每项处理结果及错误；`phase:prepared` 明确此时仅完成计算 |
| `postprocess.completed` | 助手事务成功后的 `persisted:true`、实际状态变化标记、建议数及可应用立绘条目数 |
| `message.persist_failed` | 助手保存失败原因及 `persisted:false`；先前 prepared 结果不构成已提交声明 |
| `state.changed` / `action_suggestions.created` / `character_sprite.changed` | 提交成功后的实际通知数据 |
| `run.stop_requested` | 用户取消或关机的停止请求，与最终停止结果分开 |
| `run.usage` | 结算用量事件的全部字段，保留零和未知 null 语义 |
| `run.completed` / `run.stopped` | 完整终态，包括实际 savedMessageIds、tipEntryId 和适用的 stop_reason |

上下文日志只记录最终候选的诊断，不输出 prompt、历史、角色/世界书正文或完整状态快照，不重复调用 when 或改变关键词匹配语义。`model.request` 则按要求保留真实请求正文，不再另写重复的 `model.input`。不打印 `run.delta` 或供应商 delta，也不把 delta 列表拼成“原始响应”；流式接口的完整 SDK 消息与 HTTP 原始响应字节通过 source 明确区分。

日志属于独立观测通道，不新增 SSE 事件、数据库字段、日志 HTTP 或文件生命周期。context 只返回诊断数据，仍不依赖叙事、EventHub 或日志实现。Pi 的原始数据只进入可选诊断钩子，不进入业务 ModelEvent、公开消息或 entry。

API Key、鉴权 header、明确凭据字段及模型错误中的已知密钥值先脱敏；普通业务 secret/token 字段保留。诊断副本不会改写模型请求、SDK 终态或能力结果；序列化、写入和异步观察者失败均独立兜底，不改变运行终态、状态提交或建议处理。

## 最新 AI 回复重新生成

重新生成沿用原用户消息和逻辑 runId，每次分配新的 assistantEntryId。Narrative 先校验最新用户轮次、指定 AI 与实际 tip，再持有执行锁完成删除和旧 extData.narrative 清除事务。Session.deleteEntry 仅提供通用删除、后继衔接和 tip 维护，不了解重新生成、不发布事件。首条开局 AI 和历史消息不属于此入口的合法目标。

事务提交后发送 message.deleted，必要时发送继承视图的 state.changed，再进入与普通发送相同的 start/prepareContext/execute。Context 只读取删除后的 session 当前状态；保留 compaction，但受影响摘要须通过既有 sourceHash 校验才可使用。旧 AI 的 output 不重放，session/global 状态不回退，message 状态按剩余父链继承。

新执行继续使用 run.created/summarizing/summarized/delta/usage/completed/stopped，不加 mode 或 attemptId。run 事件、活跃查询和新终态均带 assistantEntryId，stop 必须匹配该 ID 和 runId。用户消息按原 messageId 去重。删除成功后任何准备或模型失败均不恢复旧回复；部分公开输出保存，无输出只保留用户并允许显式重试。

recordedUsage 保持现存 entries.metrics 求和：被删除 AI 的请求不再计入，保留摘要的计量保留，新输出独立记录。本数值不代表不可回退的历史账单，不新增账本或 schema。没有输出/持久化失败的计量边界与普通生成相同。删除可降低 lastSeq 或使新条目复用 seq；重连需以完整最近轮次替换客户端缓存。
