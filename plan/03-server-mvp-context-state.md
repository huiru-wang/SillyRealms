# 03 · 条件加载、纯文本 Context、摘要和状态 Tool

前置：01、02。本文替代旧方案里 `off/inline/tool`、正文解析状态和 ChangeSet 的做法：状态 Tool 是唯一模型状态写入方式，Prompt、叙事正文都不能执行脚本或状态 API。

## 1. 完整状态和 when

Run 开始读取 World Global、Session 及当前 tip 祖先链最近的 Message 完整状态，验证当前 Schema；将三者复制成本轮工作区。`when` 对初始完整只读状态判断，包含未激活根；本轮激活结果一次计算后冻结，不随 Tool 或摘要重新匹配。无 Session 上下文时不虚构其状态。

角色、世界书条目和状态根复用 `evaluateLoad`：默认 always；on_mention 至少一个非空关键词，支持 any/all，任一排除词命中即不激活。关键词在每条候选叙事和当前 User 中做区分大小写的子串匹配，不跨消息；always 忽略关键词/排除词但仍检查 when。`when` 是额外 AND 条件；无 when 视为 true。运行错误、缺失状态或非 boolean 使该条不激活并报告定位诊断。

`when` 采用安全 AST 解释器，不用 `eval/Function/Node vm`。支持 JS 子集：基本字面量、括号、`!`、`&& || ??`、严格相等/大小比较、有限数字运算、`?:` 和唯一只读调用 `getState(path[, {scope}])`。path 为字符串字面量或字符串字面量数组，scope 为 global/session/message 字面量；未指定 scope 时按 global→session→message 查找，null 算命中，缺失为 undefined，可用 `??` 指定默认值。短路按该子集的 JS 语义；不允许赋值、任意属性访问、其他调用、循环、构造器或正则；拒绝 `__proto__/prototype/constructor` 等危险路径。限制表达式 4096 字节、AST 256 节点、路径 32 段、状态输入 1 MiB，超过返回诊断。导入时静态验证子集，超出能力需明确报错；不冒称完整 ECMAScript。

## 2. Prompt 和模型配置

Session 创建不检查 Preset 或模型是否可用。每轮预检读取 Session 引用的最新 World、Preset、API 模型配置和 Key；presetId 为 null 返回 `PRESET_NOT_SELECTED`，预设已删除返回 `PRESET_NOT_FOUND`，配置或凭据不可用返回相应错误，均在写本轮 Summary/User 及调用模型之前拦截；单次 Run 内固定已解析的配置。预设按配置顺序构造，但用户已确认：模型不支持中途 system 消息时，允许 Pi SDK 自动将这些 system 内容合并到前部，不再视为阻塞；当前 User 仍须恰好一次。Preset 包含 7 个系统节点 `main/personaInfo/characterInfo/worldState/chatHistory/userInput/postHistory` 和自定义文本节点；每个系统节点恰好一次、chatHistory 在 userInput 前，两者必需且当前输入恰好一次。角色、世界书按已选条件、order 和原数组位置稳定排序；世界书按 anchor 的 before/body/after 合并并继承目标角色，选中的玩家角色进 personaInfo，不重复进入 characterInfo。

所有作者文本、摘要 Prompt、历史和用户输入是 literal：不执行 EJS、JS、状态/变量 API、正则或宏，`{{user}}` 原样发送且不替换。世界卡存在脚本标记、旧 `data.context` 和不支持的字段时，返回对应 JSON 路径的警告或校验错误，不隐式解释。worldState 由 Server 把已激活状态根及当前值序列化为普通数据插入；它不是开放 Prompt 状态 API。未激活根在完整工作区中保留，但不对模型开放写入。

## 3. 固定摘要与预算

固定内部 N=40 条未覆盖可见消息、K=12 条优先保留原文、TOKEN_ESTIMATION_GUARD=1024；均不作为 World/Preset/API 的策略配置。`max_context_tokens?` 和 `max_output_tokens` 保留为预设模型预算，输入预算 `B=min(预设上限或模型 contextWindow,模型 contextWindow)-max_output_tokens-1024`，还须验证输出不大于模型 maxTokens。计算完整消息及 Tool Schema 开销；未知模型上限、预算非正或 Provider 拒绝超限时明确失败。

沿 tip 父链找到最近带应用标识的 compaction，其 `coveredThroughEntryId` 必须是该 Summary 之前同一父链的有效叙事；逻辑候选为旧摘要加覆盖点之后的可见原文，包含已正常结算或停止的用户和部分 Assistant。关键词扫描旧摘要 + 候选原文 + 当前 User；本轮新摘要不参与扫描。旧的世界卡 context 不决定策略。

未覆盖消息达到 N，或完整候选 Prompt 超 B，触发摘要：将旧摘要和较旧叙事交给同一模型，用纯文本 summary_prompt；优先保留最近 K 条原文。摘要请求自身也必须满足模型预算；超长来源按时间分批并将前批摘要传给后批，单条超长消息按 Unicode 安全边界分段且全部成功后才能覆盖该消息。生成后只替换 chatHistory，再复核完整预算；必要时增加覆盖范围或有限次缩短摘要，仍不能容纳则返回 `CONTEXT_BUDGET_EXCEEDED`。不裁本轮 User、不丢失未摘要文本、不重新激活。

只有摘要生成与最终预算均成功时，才在原 tip 后同事务写 compaction 和 User，两者使用新 run_id；原始历史不删。记录应用标识、覆盖边界和本轮摘要请求/结果到 ext_data（隐私数据不写日志），不声称调用了 Pi 原生压缩或完成了 SDK 恢复兼容。摘要失败、停止于准备阶段或 tip 已改变时，不提交不完整摘要及 User。

## 4. 直接状态 Tool 与工作区合并

Tool 根据激活的 Message Schema 开放受限操作。首版定义单个 `set_state` 工具，输入 `{path: string | string[], value: JSON}`；scope 固定为 message。只允许对已声明且已激活的叶子赋值，固定 object 根和中间分组不能整体替换；array/json 叶子允许整体替换，value 必须通过目标 Schema、大小和路径校验。每次 Tool 调用就是一次操作，**不要求或构造 ChangeSet、reason、inline 标签或由正文截取状态**。如同一字段需要多次变更，Tool 按调用完成顺序覆盖工作副本；数组追加由模型读取已给出的状态后提交完整新数组。Tool 成功返回 `{ok:true}`，失败返回安全错误及路径，不修改工作区、不提交数据库。

调用只发生于模型实际发出的工具请求；调用参数、响应和 assistant toolCall/toolResult 分别保留原始 Raw Entry，工具参数不进入可见正文。状态 Tool 不负责输出叙事，也不从工具参数合成正文。用户可见内容仅来自 Assistant 文本块；纯 ToolCall 的 Assistant 没有可见文本。无状态定义或无可写根时不注入状态 Tool；有状态且选定模型不支持 Tool 时明确返回 `MODEL_TOOL_UNSUPPORTED`，不退回正文解析。

正常完成或用户 stop 时，把 Tool 已成功写入的工作区 Message 副本与初始完整状态合并（未变字段保留），执行完整 Schema 校验；随后把完整状态和运行终态同事务持久化。Tool 已成功但没有文字时，状态快照附着到本 Run 最后一个已持久化 Entry，包括 User 或 toolResult，作为内部状态锚点且其 role/type 不变；读取始终沿父链取最近非 NULL state。Global/Session 不受本期模型工具修改。中止时未完成、未确认的 Tool 调用不生效；如果无法校验或保存则报告结算失败，保留已经落库的可见文本。进程崩溃不承诺恢复内存中的工具工作副本。

状态 Schema 类型、初始值、Opening 部分覆盖、数组/json 整值替换和不兼容诊断沿用现有 state 设计；仅上述更新协议被本方案替代。
